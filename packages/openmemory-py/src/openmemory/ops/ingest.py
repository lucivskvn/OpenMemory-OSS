import asyncio
import json
import logging
import uuid
import time
from typing import List, Dict, Any, Optional

from ..core.db import q, db
from ..memory.hsg import add_hsg_memory
from .extract import extract_text, extract_url

from ..utils.chunking import chunk_text

logger = logging.getLogger("openmemory.ops.ingest")

from ..core.security import get_encryption

# Constants for ingestion strategy
LG_THRESH = 8000
SEC_SIZE = 3000


async def mk_root(
    txt: str, ex: Dict, meta: Optional[Dict] = None, user_id: Optional[str] = None, tags: Optional[str] = None
) -> str:
    """
    Create a root memory item that serves as a container for a large document.

    Args:
        txt: Full document text.
        ex: Extraction results containing metadata.
        meta: Extra metadata to attach.
        user_id: Owner of the memory.

    Returns:
        The ID of the created root memory.
    """
    summ = txt[:500] + "..." if len(txt) > 500 else txt
    ctype = ex["metadata"]["content_type"].upper()
    sec_count = int(len(txt) / SEC_SIZE) + 1
    content = f"[Document: {ctype}]\n\n{summ}\n\n[Full content split across {sec_count} sections]"

    mid = str(uuid.uuid4())
    ts = int(time.time()*1000)

    full_meta = (meta or {}).copy()
    full_meta.update(ex["metadata"])

    try:
        await q.ins_mem(
            id=mid,
            user_id=user_id or "anonymous",
            segment=1,
            content=get_encryption().encrypt(content),
            primary_sector="reflective",
            tags=tags or json.dumps([]),
            meta=json.dumps(full_meta, default=str),
            created_at=ts,
            updated_at=ts,
            last_seen_at=ts,
            salience=1.0,
            decay_lambda=0.1,
            version=1,
            feedback_score=0,
            commit=False # Defer to parent transaction
        )
        return mid
    except Exception as e:
        logger.error(f"Failed to create root memory: {e}")
        raise e


async def mk_child(
    txt: str,
    idx: int,
    tot: int,
    p_id: str,
    meta: Optional[Dict] = None,
    user_id: Optional[str] = None,
    tags: Optional[str] = None,
) -> str:
    """
    Create a child memory item representing a section of a document.

    Args:
        txt: Section text.
        idx: Index of this section.
        tot: Total number of sections.
        p_id: Parent root ID.
        meta: Extra metadata.
        user_id: Owner ID.

    Returns:
        The ID of the created child memory.
    """
    m = meta or {}
    m.update({
        "is_child": True,
        "section_index": idx,
        "total_sections": tot,
        "parent_id": p_id
    })
    r = await add_hsg_memory(txt, tags or json.dumps([]), m, user_id, commit=False)
    return r["id"]


async def link(
    root_id_val: str, child_id: str, idx: int, user_id: Optional[str] = None
):
    """Create a waypoint link between a root and its child."""
    ts = int(time.time()*1000)
    t = q.tables
    await db.async_execute(f"INSERT INTO {t['waypoints']}(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)",
               (root_id_val, child_id, user_id or "anonymous", 1.0, ts, ts))


async def _execute_single_strategy(text: str, tags: str, meta: Dict, user_id: Optional[str]) -> Dict[str, Any]:
    """Internal helper for single memory ingestion."""
    r = await add_hsg_memory(text, tags, meta, user_id)
    return {
        "root_memory_id": r["id"],
        "child_count": 0,
        "strategy": "single",
        "extraction": meta
    }

async def _execute_root_child_strategy(
    text: str, 
    chunks: List[Dict], 
    ex: Dict, 
    meta: Dict, 
    user_id: Optional[str], 
    tags: str
) -> Dict[str, Any]:
    """Internal helper for root-child memory ingestion."""
    async with db.transaction():
        rid_val = await mk_root(text, ex, meta, user_id, tags=tags)
        for i, c in enumerate(chunks):
            cid = await mk_child(c["text"], i, len(chunks), rid_val, meta, user_id, tags=tags)
            await link(rid_val, cid, i, user_id)

        return {
            "root_memory_id": rid_val,
            "child_count": len(chunks),
            "strategy": "root-child",
            "extraction": ex["metadata"]
        }

async def ingest_document(
    t: str,
    data: Any,
    meta: Optional[Dict] = None,
    cfg: Optional[Dict] = None,
    user_id: Optional[str] = None,
    tags: Optional[list] = None,
) -> Dict[str, Any]:
    """
    Ingest a document, automatically deciding between single or root-child strategy.
    
    Args:
        t: Source text or content descriptor.
        data: Raw data (bytes or str).
        meta: Optional metadata.
        cfg: Configuration overrides (lg_thresh, sec_sz, etc).
        user_id: Target user ID.
        tags: Optional tags list.
    """
    th = cfg.get("lg_thresh", LG_THRESH) if cfg else LG_THRESH
    sz = cfg.get("sec_sz", SEC_SIZE) if cfg else SEC_SIZE

    if not user_id and meta and "user_id" in meta:
        user_id = meta["user_id"]

    ex = await extract_text(t, data, user_id=user_id)
    text = ex["text"]
    ex_meta = ex["metadata"]
    est_tok = ex_meta["estimated_tokens"]

    use_rc = (cfg and cfg.get("force_root")) or est_tok > th
    tags_json = json.dumps(tags or [])
    
    m = (meta or {}).copy()
    m.update(ex_meta)
    m.update({"ingested_at": int(time.time()*1000)})

    if not use_rc:
        m["ingestion_strategy"] = "single"
        res = await _execute_single_strategy(text, tags_json, m, user_id)
        res["total_tokens"] = est_tok
        return res

    # Use robust chunking for splitting
    chunks = chunk_text(text, tgt=sz, ovr=cfg.get("overlap", 0.1) if cfg else 0.1)
    logger.info(f"Splitting text into {len(chunks)} sections for ingest")
    
    m["ingestion_strategy"] = "root-child"
    try:
        res = await _execute_root_child_strategy(text, chunks, ex, m, user_id, tags_json)
        res["total_tokens"] = est_tok
        return res
    except Exception as e:
        logger.exception(f"Ingest document failed: {e}")
        raise e


async def ingest_url(
    url: str,
    meta: Optional[Dict] = None,
    cfg: Optional[Dict] = None,
    user_id: Optional[str] = None,
    tags: Optional[list] = None,
) -> Dict[str, Any]:
    """
    Ingest text content from a URL with automatic strategy selection.
    """
    ex = await extract_url(url, user_id=user_id)
    
    th = cfg.get("lg_thresh", LG_THRESH) if cfg else LG_THRESH
    sz = cfg.get("sec_sz", SEC_SIZE) if cfg else SEC_SIZE
    est_tok = ex["metadata"]["estimated_tokens"]

    use_rc = (cfg and cfg.get("force_root")) or est_tok > th
    tags_json = json.dumps(tags or [])
    
    m = (meta or {}).copy()
    m.update(ex["metadata"])
    m.update({"source_url": url, "ingested_at": int(time.time()*1000)})

    if not use_rc:
        m["ingestion_strategy"] = "single"
        res = await _execute_single_strategy(ex["text"], tags_json, m, user_id)
        res["total_tokens"] = est_tok
        return res

    # Use robust chunking
    chunks = chunk_text(ex["text"], tgt=sz, ovr=cfg.get("overlap", 0.1) if cfg else 0.1)
    
    m["ingestion_strategy"] = "root-child"
    try:
        res = await _execute_root_child_strategy(ex["text"], chunks, ex, m, user_id, tags_json)
        res["total_tokens"] = est_tok
        return res
    except Exception as e:
        logger.error(f"URL ingest failed for {url}: {e}", exc_info=True)
        raise e
