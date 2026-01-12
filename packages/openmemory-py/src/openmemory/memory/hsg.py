import time
import math
import asyncio
import json
import re
import random
import numpy as np
import uuid
import logging
from typing import List, Dict, Any, Optional, Set, Tuple
from ..core.types import MemoryItem

logger = logging.getLogger("openmemory.memory.hsg")

from ..core.db import q, db, transaction
from ..core.config import env
from ..core.constants import SECTOR_CONFIGS
from ..core.vector_store import vector_store as store
from ..utils.text import canonical_token_set, canonical_tokens_from_text
from ..utils.chunking import chunk_text
from ..utils.keyword import keyword_filter_memories, compute_keyword_overlap
from .embed import embed_multi_sector, embed_for_sector, calc_mean_vec, embed_batch_multi_sector
from .decay import inc_q, dec_q, on_query_hit, calc_recency_score as calc_recency_score_decay, pick_tier, calc_decay, apply_decay
from ..utils.vectors import buf_to_vec, vec_to_buf, cos_sim, compress_vec_for_storage
# In backend/src/memory/hsg.ts line 275: export function calc_recency_score.
from ..core.learned_classifier import LearnedClassifier
from ..ops.dynamics import (
    calculateCrossSectorResonanceScore,
    applyRetrievalTraceReinforcementToMemory,
    propagateAssociativeReinforcementToLinkedNodes,
    SCORING_WEIGHTS,
    HYBRID_PARAMS,
    REINFORCEMENT,
    COGNITIVE_PARAMS,
    SECTOR_RELATIONSHIPS
)
from .user_summary import update_user_summary
from ..temporal_graph.query import query_facts_at_time

from ..core.security import get_encryption

async def embed_query_for_all_sectors(query: str, sectors: List[str], user_id: Optional[str] = None) -> Dict[str, List[float]]:
    # port of embedQueryForAllSectors
    res = {}
    for s in sectors:
        res[s] = await embed_for_sector(query, s, user_id=user_id)
    return res

def has_temporal_markers(text: str) -> bool:
    pats = [
        r"\b(today|yesterday|tomorrow|this\s+week|last\s+week|this\s+morning)\b",
        r"\b\d{4}-\d{2}-\d{2}\b",
        r"\b20\d{2}[/-]?(0[1-9]|1[0-2])[/-]?(0[1-9]|[12]\d|3[01])\b",
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}",
        r"\bwhat\s+(did|have)\s+(i|we)\s+(do|done)\b",
    ]
    return any(re.search(p, text, re.I) for p in pats)

def safe_json_loads(val: Any, default: Any = None) -> Any:
    if not val: return default
    try:
        if isinstance(val, (dict, list)): return val
        return json.loads(str(val))
    except:
        return default

def compute_tag_match_score_sync(tags_json: Optional[str], q_toks: Set[str]) -> float:
    if not tags_json: return 0.0
    try:
        tags = json.loads(tags_json)
        if not isinstance(tags, list): return 0.0
        matches = 0
        for tag in tags:
            tl = str(tag).lower()
            if tl in q_toks: matches += 2
            else:
                for tok in q_toks:
                    if tl in tok or tok in tl: matches += 1
        return min(1.0, matches / max(1, len(tags) * 2))
    except Exception:
        return 0.0




def classify_content(content: str, metadata: Any = None) -> Dict[str, Any]:
    # return {primary, additional, confidence}
    meta_sec = metadata.get("sector") if isinstance(metadata, dict) else None
    if meta_sec and meta_sec in SECTOR_CONFIGS:
        return {"primary": meta_sec, "additional": [], "confidence": 1.0}

    scores = {k: 0.0 for k in SECTOR_CONFIGS}
    for sec, cfg in SECTOR_CONFIGS.items():
        score = 0
        for pat in cfg["patterns"]:
            matches = pat.findall(content)
            if matches:
                score += len(matches) * cfg["weight"]
        scores[sec] = score

    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    primary, p_score = sorted_scores[0]
    thresh = max(1.0, p_score * 0.3)

    additional = [s for s, sc in sorted_scores[1:] if sc > 0 and sc >= thresh]

    second_score = sorted_scores[1][1] if len(sorted_scores) > 1 else 0
    confidence = min(1.0, p_score / (p_score + second_score + 1)) if p_score > 0 else 0.2

    return {
        "primary": primary if p_score > 0 else "semantic", # default semantic
        "additional": additional,
        "confidence": confidence
    }



def boosted_sim(s: float) -> float:
    return 1 - math.exp(-HYBRID_PARAMS["tau"] * s)

def compute_simhash(text: str) -> str:
    tokens = canonical_token_set(text)
    hashes = []
    for t in tokens:
        h = 0
        for c in t:
            # (h<<5) - h + ord(c) | 0 in JS
            val = (h << 5) - h + ord(c)
            # Enforce 32-bit signed behavior
            val = val & 0xffffffff
            if val > 0x7fffffff:
                val -= 0x100000000
            h = val
        hashes.append(h)

    vec = [0] * 64
    for h in hashes:
        for i in range(64):
            # JS line 309: if (h & (1 << i)).
            # In JS, 1 << i wraps the shift amount to i % 32.
            # So bit 0 of h is checked for i=0 and i=32.
            bit = 1 << (i % 32)
            if h & bit:
                vec[i] += 1
            else:
                vec[i] -= 1

    res_hash = ""
    for i in range(0, 64, 4):
        nibble = 0
        if vec[i] > 0: nibble += 8
        if vec[i+1] > 0: nibble += 4
        if vec[i+2] > 0: nibble += 2
        if vec[i+3] > 0: nibble += 1
        res_hash += format(nibble, 'x')
    return res_hash

def hamming_dist(h1: str, h2: str) -> int:
    dist = 0
    for i in range(len(h1)):
        x = int(h1[i], 16) ^ int(h2[i], 16)
        if x & 8: dist += 1
        if x & 4: dist += 1
        if x & 2: dist += 1
        if x & 1: dist += 1
    return dist

def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))

def extract_essence(raw: str, sec: str, max_len: int) -> str:
    if not env.use_summary_only or len(raw) <= max_len: return raw
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", raw) if len(s.strip()) > 10]
    if not sents: return raw[:max_len]

    scored = []
    for idx, s in enumerate(sents):
        sc = 0
        if idx == 0: sc += 10
        if idx == 1: sc += 5
        if re.match(r"^#+\s", s) or re.match(r"^[A-Z][A-Z\s]+:", s): sc += 8
        if re.match(r"^[A-Z][a-z]+:", s): sc += 6
        if re.search(r"\d{4}-\d{2}-\d{2}", s): sc += 7
        if re.search(r"\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+", s, re.I): sc += 5
        if re.search(r"\$\d+|\d+\s*(miles|dollars|years|months|km)", s): sc += 4
        if re.search(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+", s): sc += 3
        if re.search(r"\b(bought|purchased|serviced|visited|went|got|received|paid|earned|learned|discovered|found|saw|met|completed|finished|fixed|implemented|created|updated|added|removed|resolved)\b", s, re.I): sc += 4
        if re.search(r"\b(who|what|when|where|why|how)\b", s, re.I): sc += 2
        if len(s) < 80: sc += 2
        if re.search(r"\b(I|my|me)\b", s): sc += 1
        scored.append({"text": s, "score": sc, "idx": idx})

    scored.sort(key=lambda x: x["score"], reverse=True)

    selected = []
    curr_len = 0

    # Always first
    first = next((x for x in scored if x["idx"] == 0), None)
    if first and len(first["text"]) < max_len:
        selected.append(first)
        curr_len += len(first["text"])

    for item in scored:
        if item["idx"] == 0: continue
        if curr_len + len(item["text"]) + 2 <= max_len:
            selected.append(item)
            curr_len += len(item["text"]) + 2

    selected.sort(key=lambda x: x["idx"])
    return " ".join(x["text"] for x in selected)

def compute_token_overlap(q_toks: Set[str], mem_toks: Set[str]) -> float:
    if not q_toks: return 0.0
    ov = len(q_toks.intersection(mem_toks))
    return ov / len(q_toks)

def generate_trace(metrics: Dict[str, Any], primary_sector: str) -> str:
    """Generates a human-readable justification for recall."""
    just = f"Recalled via {primary_sector} resonance"
    if metrics.get("sim_adj", 0) > 0.6:
        just += f" (high semantic similarity: {metrics['sim_adj']:.2f})"
    elif metrics.get("tok_ov", 0) > 0.4:
        just += f" (strong keyword overlap: {metrics['tok_ov']:.2f})"

    if metrics.get("waypoint", 0) > 0.2:
        just += f", linked via associative waypoint ({metrics['waypoint']:.2f})"

    if metrics.get("recency", 0) > 0.8:
        just += ", reinforced by recent interaction"
    elif metrics.get("recency", 0) < 0.2:
        just += ", retrieved from long-term memory"

    if metrics.get("tag", 0) > 0.5:
        just += " (matched user tags)"

    return just

def compute_hybrid_score(sim: float, tok_ov: float, ww: float, rec_sc: float, kw_score: float = 0, tag_match: float = 0) -> float:
    s_p = boosted_sim(sim)
    raw = (SCORING_WEIGHTS["similarity"] * s_p +
           SCORING_WEIGHTS["overlap"] * tok_ov +
           SCORING_WEIGHTS["waypoint"] * ww +
           SCORING_WEIGHTS["recency"] * rec_sc +
           SCORING_WEIGHTS["tag_match"] * tag_match +
           kw_score)
    return sigmoid(raw)

async def create_single_waypoint(new_id: str, new_mean: List[float], ts: int, user_id: str = "anonymous"):
    """
    Creates an associative link between a new memory and its most semantically similar 
    predecessor within the same user's scope.
    """
    # Strictly isolate by user_id
    if user_id and user_id != "anonymous":
        mems = await q.all_mem_by_user(user_id, 250, 0)
    else:
        # For anonymous, we still want to isolate to anonymous cluster
        mems = await q.all_mem(250, 0, user_id="anonymous")
        
    best = None
    best_sim = -1.0

    nm = np.array(new_mean, dtype=np.float32)

    for mem in mems:
        if mem["id"] == new_id or not mem["mean_vec"]: continue
        ex_mean = np.array(buf_to_vec(mem["mean_vec"]), dtype=np.float32)
        sim = cos_sim(nm, ex_mean)
        if sim > best_sim:
            best_sim = sim
            best = mem["id"]

    t = q.tables
    if best:
        await db.async_execute(f"INSERT OR REPLACE INTO {t['waypoints']}(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)", (new_id, best, user_id, float(best_sim), ts, ts))
    else:
        # Self-link if it's the first memory for this user
        await db.async_execute(f"INSERT OR REPLACE INTO {t['waypoints']}(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)", (new_id, new_id, user_id, 1.0, ts, ts))


async def create_inter_mem_waypoints(new_id: str, prim_sec: str, new_vec: List[float], ts: int, user_id: str = "anonymous"):
    """
    Creates bi-directional semantic links between memories in the same sector 
    and same user scope if they exceed a similarity threshold.
    """
    thresh = 0.85 # Increased threshold for higher precision in inter-mem links
    wt = 0.5
    
    t = q.tables
    # CRITICAL: Added user_id filter to prevent cross-user linkage
    # Also added LIMIT 100 to prevent performance degradation/OOM with large memory bases
    sql = f"SELECT id, v FROM {t['vectors']} WHERE sector=? AND user_id=? ORDER BY id DESC LIMIT 100"
    rows = await db.async_fetchall(sql, (prim_sec, user_id))
    
    nv = np.array(new_vec, dtype=np.float32)
    for r in rows:
        if r["id"] == new_id:
            continue
        ex_vec = np.array(buf_to_vec(r["v"]), dtype=np.float32)
        sim = cos_sim(nv, ex_vec)
        if sim >= thresh:
            # Bi-directional linking
            await db.async_execute(f"INSERT OR REPLACE INTO {t['waypoints']}(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)", (new_id, r["id"], user_id, wt, ts, ts))
            await db.async_execute(f"INSERT OR REPLACE INTO {t['waypoints']}(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)", (r["id"], new_id, user_id, wt, ts, ts))


async def calc_multi_vec_fusion_score(mid: str, qe: Dict[str, List[float]], w: Dict[str, float], pre_fetched_vecs: Optional[List[Any]] = None) -> float:
    vecs = pre_fetched_vecs if pre_fetched_vecs is not None else await store.getVectorsById(mid)
    s = 0.0
    tot = 0.0

    wm = {
         "semantic": w.get("semantic_dimension_weight", 0),
         "emotional": w.get("emotional_dimension_weight", 0),
         "procedural": w.get("procedural_dimension_weight", 0),
         "episodic": w.get("temporal_dimension_weight", 0),
         "reflective": w.get("reflective_dimension_weight", 0),
    }

    for v in vecs:
        qv = qe.get(v.sector)
        if not qv: continue
        sim = cos_sim(v.vector, qv)
        wgt = wm.get(v.sector, 0.5)
        s += sim * wgt
        tot += wgt

    return s / tot if tot > 0 else 0.0

async def _learned_refine(content: str, mean_vec: List[float], user_id: str, forced_sector: Optional[str] = None):
    """Refine memory sectors using user-specific learned classifier."""
    refined = {"primary": None, "additional": []}
    try:
        model_row = await q.get_classifier_model(user_id)
        if model_row:
            model = {
                "weights": json.loads(model_row["weights"]),
                "biases": json.loads(model_row["biases"])
            }
            learned_cls = LearnedClassifier.predict(mean_vec, model)
            if learned_cls["confidence"] > 0.4:
                logger.info(f"[HSG] Learned Refinement for {user_id}: {learned_cls['primary']} (conf: {learned_cls['confidence']:.2f})")
                
                if not forced_sector:
                    refined["primary"] = learned_cls["primary"]
                refined["additional"] = learned_cls["additional"]
    except Exception as e:
        logger.error(f"[HSG] Learned classifier refinement error: {e}")
    return refined

async def _graph_link(mid: str, mean_vec: List[float], primary_sector: str, user_id: str, ts: int):
    """Establish semantic and associative links for a new memory."""
    # 1. Primary associative link (semantic gravity)
    await create_single_waypoint(mid, mean_vec, ts, user_id)
    # 2. Inter-memory sector-specific links
    await create_inter_mem_waypoints(mid, primary_sector, mean_vec, ts, user_id)

async def add_hsg_memory(content: str, tags: Optional[str] = None, metadata: Any = None, user_id: Optional[str] = None, commit: bool = True, id_override: Optional[str] = None, created_at_override: Optional[int] = None) -> Dict[str, Any]:
    async with transaction():
        simhash = compute_simhash(content)
        
        if id_override:
            existing_id = await q.get_mem(id_override, user_id)
            if existing_id:
                # If recovering, maybe we update? Or skip?
                pass 

        existing = await q.get_mem_by_simhash(simhash, user_id)

        if existing and hamming_dist(simhash, existing["simhash"]) <= COGNITIVE_PARAMS["HAMMING_THRESHOLD"] and not id_override:
            now = int(time.time()*1000)
            boost = min(1.0, (existing["salience"] or 0) + COGNITIVE_PARAMS["DEDUPLICATION_BOOST"])
            # Fast update for existing memory
            await q.upd_seen(existing["id"], now, boost, now, user_id)
            return {
                "id": existing["id"],
                "primary_sector": existing["primary_sector"],
                "sectors": [existing["primary_sector"]],
                "deduplicated": True,
                "created_at": existing.get("created_at", now),
                "simhash": existing.get("simhash"),
                "generated_summary": existing.get("generated_summary")
            }

        mid = id_override or str(uuid.uuid4())
        now_ts = created_at_override or int(time.time()*1000)

        # Classification and Chunking
        chunks = chunk_text(content)
        use_chunks = len(chunks) > 1

        # Allow metadata override for primary sector
        forced_sector = (metadata or {}).get("primary_sector") or (metadata or {}).get("sector")
        cls = classify_content(content, metadata)
        if forced_sector in SECTOR_CONFIGS:
            cls["primary"] = forced_sector
            if forced_sector not in cls["additional"]:
                cls["additional"].append(forced_sector)

        all_secs = [cls["primary"]] + cls["additional"]

        # 1. Pre-calculate embeddings
        emb_res = await embed_multi_sector(mid, content, all_secs, chunks if use_chunks else None, user_id=user_id, commit=False)  # type: ignore
        mean_vec = calc_mean_vec(emb_res, all_secs)

        # 3. Learned Classifier Refinement
        if user_id:
            refined = await _learned_refine(content, mean_vec, user_id, forced_sector)
            if refined["primary"]:
                logger.info(f"[HSG] Applying Learned Refinement: {cls['primary']} -> {refined['primary']}")
                
                if refined["primary"] not in all_secs:
                    new_emb = await embed_for_sector(content, refined["primary"], user_id=user_id)
                    emb_res.append({"sector": refined["primary"], "vector": new_emb, "dim": len(new_emb)})
                    all_secs.append(refined["primary"])
                    mean_vec = calc_mean_vec(emb_res, [refined["primary"]] + refined["additional"])
                
                cls["primary"] = refined["primary"]
            
            cls["additional"] = list(set(cls["additional"] + refined["additional"]))

        # Mean Vector Buffering
        mean_buf = vec_to_buf(mean_vec)
        comp_buf = None
        if env.tier == "smart" and len(mean_vec) > 128:
            comp = compress_vec_for_storage(mean_vec, 128)
            comp_buf = vec_to_buf(comp)

        if user_id:
            u = await q.get_user(user_id)
            if not u:
                await q.ins_user(user_id, "User profile initializing...", 0, now_ts, now_ts)

        # Segments logic
        max_seg_res = await q.get_max_segment(user_id)
        cur_seg = max_seg_res["max_seg"] if max_seg_res else 0
        cnt_res = await q.get_segment_count(cur_seg, user_id)
        if cnt_res and cnt_res["c"] >= env.seg_size:
            cur_seg += 1

        stored_content = extract_essence(content, cls["primary"], env.summary_max_length)
        stored_content_enc = get_encryption().encrypt(stored_content)

        sec_cfg = SECTOR_CONFIGS[cls["primary"]]
        init_sal = max(0.0, min(1.0, 0.4 + 0.1 * len(cls["additional"])))

        # Inject additional sectors into metadata for retrieval parity
        final_meta = (metadata or {}).copy()
        if cls["additional"]:
            final_meta["additional_sectors"] = cls["additional"]

        # Insert Memory Record
        await q.ins_mem(
            id=mid,
            user_id=user_id or "anonymous",
            segment=cur_seg,
            content=stored_content_enc,
            simhash=simhash,
            primary_sector=cls["primary"],
            tags=tags,
            meta=json.dumps(final_meta),
            created_at=now_ts,
            updated_at=now_ts,
            last_seen_at=now_ts,
            salience=init_sal,
            decay_lambda=sec_cfg["decay_lambda"],
            version=1,
            mean_dim=len(mean_vec),
            mean_vec=mean_buf,
            compressed_vec=comp_buf,
            feedback_score=0,
            commit=False
        )

        # Store Sector-specific Vectors
        for r in emb_res:
            await store.storeVector(mid, r["sector"], r["vector"], r["dim"], user_id or "anonymous")

        # Create Waypoints (Graph Linking)
        await _graph_link(mid, mean_vec, cls["primary"], user_id or "anonymous", now_ts)

        # Post-commit: Trigger summary update
        if user_id:
            def _bg_summary_update():
                asyncio.create_task(update_user_summary(user_id))
            
            # Simple wrapper or just fire and forget but with a logger catch?
            # Better to use a safe launcher helper if we had one, but strict inline:
            async def _safe_update():
                try:
                    await update_user_summary(user_id)
                except Exception as e:
                    logger.error(f"[HSG] Background summary update failed: {e}")
            
            asyncio.create_task(_safe_update())

        return {
            "id": mid,
            "content": content,
            "primary_sector": cls["primary"],
            "sectors": all_secs,
            "chunks": len(chunks),
            "salience": init_sal,
            "created_at": now_ts,
            "simhash": simhash,
            "generated_summary": None 
        }

async def add_hsg_memories(items: List[Dict[str, Any]], user_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Experimental high-throughput batch ingestion.
    items: List of {'content', 'tags', 'metadata'}
    """
    if not items: return []
    
    results = [None] * len(items)
    pending_ingestion = [] # Indices of items that need embedding
    
    # 1. Deduplication loop (Fast check)
    async with transaction():
        for i, item in enumerate(items):
            content = item["content"]
            sh = compute_simhash(content)
            existing = await q.get_mem_by_simhash(sh, user_id)
            if existing and hamming_dist(sh, existing["simhash"]) <= COGNITIVE_PARAMS["HAMMING_THRESHOLD"]:
                now = int(time.time()*1000)
                boost = min(1.0, (existing["salience"] or 0) + COGNITIVE_PARAMS["DEDUPLICATION_BOOST"])
                await q.upd_seen(existing["id"], now, boost, now, user_id)
                results[i] = {
                    "id": existing["id"],
                    "deduplicated": True,
                    "created_at": existing.get("created_at", now)
                }
            else:
                # Needs full processing
                mid = str(uuid.uuid4())
                cls = classify_content(content, item.get("metadata"))
                secs = [cls["primary"]] + cls["additional"]
                pending_ingestion.append({
                    "idx": i,
                    "id": mid,
                    "content": content,
                    "simhash": sh,
                    "cls": cls,
                    "sectors": secs
                })

    if not pending_ingestion:
        return [r for r in results if r is not None]

    # 2. Batch Embedding
    emb_payload = [{"id": p["id"], "content": p["content"], "sectors": p["sectors"]} for p in pending_ingestion]
    emb_results = await embed_batch_multi_sector(emb_payload, user_id=user_id, commit=True)
    
    # 3. Final Ingestion Loop
    encryption = get_encryption()
    now_ts = int(time.time()*1000)
    
    async with transaction():
        # Pre-fetch user and segment info once
        if user_id:
            u = await q.get_user(user_id)
            if not u:
                await q.ins_user(user_id, "User profile initializing...", 0, now_ts, now_ts)
        
        max_seg_res = await q.get_max_segment(user_id)
        cur_seg = max_seg_res["max_seg"] if max_seg_res else 0
        cnt_res = await q.get_segment_count(cur_seg, user_id)
        current_cnt = cnt_res["c"] if cnt_res else 0

        for i, p in enumerate(pending_ingestion):
            idx = p["idx"]
            mid = p["id"]
            content = p["content"]
            cls = p["cls"]
            sh = p["simhash"]
            embs = emb_results[i]
            
            mean_vec = calc_mean_vec(embs, p["sectors"])
            
            # 3b. Batch Learned Refinement
            if user_id:
                refined = await _learned_refine(content, mean_vec, user_id)
                
                if refined["primary"]:
                    # Parity Fix: If primary changed to a new sector, we MUST embed it
                    if refined["primary"] not in p["sectors"]:
                        try:
                            logger.info(f"[HSG] Batch Refinement New Sector: {p['cls']['primary']} -> {refined['primary']}")
                            new_emb = await embed_for_sector(content, refined["primary"], user_id=user_id)
                            embs.append({"sector": refined["primary"], "vector": new_emb, "dim": len(new_emb)})
                            p["sectors"].append(refined["primary"])
                            # Recalculate mean with new sector
                            mean_vec = calc_mean_vec(embs, p["sectors"])
                        except Exception as e:
                            logger.error(f"[HSG] Failed to embed refined sector {refined['primary']} in batch: {e}")

                    p["cls"]["primary"] = refined["primary"]
                p["cls"]["additional"] = list(set(p["cls"]["additional"] + refined["additional"]))

            mean_buf = vec_to_buf(mean_vec)
            
            # Segment overflow check
            if current_cnt >= env.seg_size:
                cur_seg += 1
                current_cnt = 0
            current_cnt += 1
            
            stored_content = extract_essence(content, cls["primary"], env.summary_max_length)
            stored_content_enc = encryption.encrypt(stored_content)
            
            # Metadata handling
            meta_in = items[idx].get("metadata") or {}
            final_meta = meta_in.copy()
            if cls["additional"]:
                final_meta["additional_sectors"] = cls["additional"]

            await q.ins_mem(
                id=mid,
                user_id=user_id or "anonymous",
                segment=cur_seg,
                content=stored_content_enc,
                simhash=sh,
                primary_sector=cls["primary"],
                tags=items[idx].get("tags"),
                meta=json.dumps(final_meta),
                created_at=now_ts,
                updated_at=now_ts,
                last_seen_at=now_ts,
                salience=max(0.0, min(1.0, 0.4 + 0.1 * len(cls["additional"]))),
                decay_lambda=SECTOR_CONFIGS[cls["primary"]]["decay_lambda"],
                version=1,
                mean_dim=len(mean_vec),
                mean_vec=mean_buf,
                commit=False
            )
            
            # Store individual sector vectors
            for r in embs:
                await store.storeVector(mid, r["sector"], r["vector"], r["dim"], user_id or "anonymous")
            
            # Establish graph links (Graph Linking)
            await _graph_link(mid, mean_vec, cls["primary"], user_id or "anonymous", now_ts)
            
            results[idx] = {
                "id": mid,
                "primary_sector": cls["primary"],
                "sectors": p["sectors"]
            }
            
    return [r for r in results if r is not None]

class HSGState:
    def __init__(self):
        self.cache: Dict[str, Dict[str, Any]] = {}
        self.coact_buf: List[Tuple[Optional[str], str, str]] = []
        self.TTL = 60000
        self.max_cache_size = 1000

    def purge_cache(self):
        if len(self.cache) > self.max_cache_size:
            self.cache.clear()

hsg_state = HSGState()

async def _coactivation_worker():
    if not hsg_state.coact_buf:
        return

    pairs = hsg_state.coact_buf[:50]
    hsg_state.coact_buf = hsg_state.coact_buf[50:]

    now = int(time.time() * 1000)
    tau_ms = HYBRID_PARAMS["tau_hours"] * 3600000

    t = q.tables
    async with transaction():
        # Batch fetch all needed memories
        unique_ids = set()
        for _, a, b in pairs:
            unique_ids.add(a)
            unique_ids.add(b)
        
        mem_map = {}
        if unique_ids:
            # We fetch without user_id constraint initially and validate later, or do we?
            # get_mems_by_ids allows optional user_id. Here we might have mixed users if buffer isn't pure.
            # But the loop checks for user mismatch.
            # Let's fetch all.
            fetched = await q.get_mems_by_ids(list(unique_ids))
            mem_map = {m["id"]: m for m in fetched}

        for uid, a, b in pairs:
            try:
                memA = mem_map.get(a)
                memB = mem_map.get(b)
                if not memA or not memB:
                    continue
                if memA["user_id"] != memB["user_id"]:
                    continue
                if uid and (memA["user_id"] != uid or memB["user_id"] != uid):
                    continue

                time_diff = abs(memA["last_seen_at"] - memB["last_seen_at"])
                temp_fact = math.exp(-time_diff / tau_ms)

                # Use raw SQL to handle OR REPLACE easily as in single_waypoint
                row = await db.async_fetchone(f"SELECT weight, created_at, user_id FROM {t['waypoints']} WHERE src_id=? AND dst_id=?", (a, b))
                cur_wt = row["weight"] if row else 0.0
                new_wt = min(1.0, cur_wt + HYBRID_PARAMS["eta"] * (1.0 - cur_wt) * temp_fact)

                user_id = row["user_id"] if row else (memA["user_id"] or memB["user_id"] or "anonymous")
                created_at = row["created_at"] if row else now

                await db.async_execute(f"INSERT OR REPLACE INTO {t['waypoints']}(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                           (a, b, user_id, new_wt, created_at, now))
            except Exception as e:
                logger.warning(f"[HSG] Coactivation worker error: {e}")
                pass

def trigger_coactivation_sync():
    asyncio.create_task(_coactivation_worker())

async def reinforce_waypoints(path: List[str], user_id: str = "anonymous"):
    now = int(time.time() * 1000)
    t = q.tables
    for i in range(len(path) - 1):
        src_id = path[i]
        dst_id = path[i+1]
        await db.async_execute(
            f"UPDATE {t['waypoints']} SET weight=MIN(?, weight + ?), updated_at=? WHERE src_id=? AND dst_id=? AND (user_id=? OR (user_id IS NULL AND ? IS NULL))",
            (
                REINFORCEMENT["max_waypoint_weight"],
                REINFORCEMENT["waypoint_boost"],
                now,
                src_id,
                dst_id,
                user_id,
                user_id,
            ),
        )

async def run_decay_process() -> Dict[str, int]:
    """Alias for standardized background decay process."""
    # We could just call apply_decay directly, but keeping the signature for backward compatibility
    # if anyone was calling it (though grep says no). 
    # Return value might differ, apply_decay currently returns None (logs progress).
    await apply_decay()
    return {"status": "completed"}

async def expand_via_waypoints(ids: List[str], max_exp: int = 15, user_id: Optional[str] = None):
    """
    Expand memory IDs via waypoint graph traversal using Layer-based BFS.
    Optimized to O(depth) queries instead of O(nodes) N+1 pattern.
    """
    if not ids: return []
    
    vis = set(ids)
    results = [] # List of {"id", "weight", "path"}
    
    # Current "frontier" of nodes to expand
    # Each entry: (id, current_weight, path_to_node)
    frontier = [(i, 1.0, [i]) for i in ids]
    
    t = q.tables
    limit_per_layer = 50 # Prevent explosion
    
    # BFS traversal depth is implicitly limited by weight decay (exp_wt < 0.1)
    # and total max_exp results count.
    while frontier and len(results) < max_exp:
        current_ids = [node[0] for node in frontier]
        frontier_map = {node[0]: node for node in frontier}
        frontier = [] # Reset for next layer
        
        # Batch fetch all neighbors for the current frontier
        placeholders = ",".join(["?"] * len(current_ids))
        sql = f"SELECT src_id, dst_id, weight FROM {t['waypoints']} WHERE src_id IN ({placeholders})"
        params = list(current_ids)
        if user_id:
            sql += " AND user_id = ?"
            params.append(user_id)
        
        sql += " ORDER BY weight DESC"
        
        rows = await db.async_fetchall(sql, tuple(params))
        
        for r in rows:
            if len(results) >= max_exp: break
            
            src = r["src_id"]
            dst = r["dst_id"]
            
            if dst in vis: continue
            
            parent = frontier_map[src]
            wt = min(1.0, max(0.0, float(r["weight"])))
            exp_wt = parent[1] * wt * COGNITIVE_PARAMS["WAYPOINT_DECAY"] # Decay factor
            
            if exp_wt < COGNITIVE_PARAMS["EXPAN_MIN_WEIGHT"]: continue
            
            item = {"id": dst, "weight": exp_wt, "path": parent[2] + [dst]}
            results.append(item)
            vis.add(dst)
            
            if len(frontier) < limit_per_layer:
                frontier.append((dst, exp_wt, item["path"]))
                
    return results


async def hsg_query(
    qt: str, k: int = 10, f: Optional[Dict[str, Any]] = None
) -> List[MemoryItem]:
    # f: {sectors, minSalience, user_id, startTime, endTime}
    start_q = time.time()
    inc_q()
    try:
        f = f or {}
        cache_key = f"{qt}:{k}:{json.dumps(f, sort_keys=True)}"
        if cache_key in hsg_state.cache:
            entry = hsg_state.cache[cache_key]
            if time.time()*1000 - entry["t"] < hsg_state.TTL: return entry["r"]

        qc = classify_content(qt)
        qtk = canonical_token_set(qt)
        primary_sectors = [qc["primary"]] + qc["additional"]

        ss = f.get("sectors") or list(SECTOR_CONFIGS.keys())
        if not ss: ss = ["semantic"]

        qe = await embed_query_for_all_sectors(qt, ss, user_id=f.get("user_id"))

        # Temporal Awareness
        if has_temporal_markers(qt):
            logger.info(f"[HSG] Temporal marker detected in query: {qt}")
            t_facts = await query_facts_at_time(user_id=f.get("user_id"), min_confidence=0.5)
            # In a more advanced version, we'd use these facts to re-rank or augment the query.
            # For now, we log the detection as a bridge achievement.

        # Refine using Learned Classifier
        if f.get("user_id"):
            try:
                model_row = await q.get_classifier_model(f["user_id"])
                if model_row:
                    model = {
                        "weights": json.loads(model_row["weights"]),
                        "biases": json.loads(model_row["biases"])
                    }
                    emb_res_for_mean = []
                    for sec, vec in qe.items():
                        emb_res_for_mean.append({"sector": sec, "vector": vec, "dim": len(vec)})

                    q_mean = calc_mean_vec(emb_res_for_mean, ss)
                    learned_qc = LearnedClassifier.predict(q_mean, model)

                    if learned_qc["confidence"] > 0.5:
                        logger.info(f"[HSG] Query refined for {f['user_id']}: {qc['primary']} -> {learned_qc['primary']}")
                        qc["primary"] = learned_qc["primary"]
                        # Extend additional sectors
                        qc["additional"] = list(set(qc["additional"] + learned_qc["additional"]))
            except Exception as e:
                logger.warning(f"[HSG] Learned classifier refinement failed: {e}")
                pass

        w = {
            "semantic_dimension_weight": 1.2 if qc["primary"] == "semantic" else 0.8,
            "emotional_dimension_weight": 1.5 if qc["primary"] == "emotional" else 0.6,
            "procedural_dimension_weight": 1.3 if qc["primary"] == "procedural" else 0.7,
            "temporal_dimension_weight": 1.4 if qc["primary"] == "episodic" else 0.7,
            "reflective_dimension_weight": 1.1 if qc["primary"] == "reflective" else 0.5,
        }

        # Search vectors
        sr = {}
        for s in ss:
            qv = qe[s] # list[float]
            search_opts = {"user_id": f.get("user_id")}
            if f.get("metadata"):
                search_opts["metadata"] = f.get("metadata")
            
            # Iterative Expansion to prevent starvation
            # If temporal/salience filters are strong, we might need to fetch many more candidates
            # to find K valid ones.
            base_mult = 5 if (f.get("startTime") or f.get("endTime") or f.get("minSalience")) else 2
            multiplier = base_mult
            
            while True:
                req_k = k * multiplier
                res = await store.search(qv, s, req_k, filters=search_opts) # type: ignore
                
                # Check saturation if filters exist
                if not res or (not f.get("startTime") and not f.get("endTime") and not f.get("minSalience")):
                    # No complex filters -> Trust vector store
                    break
                    
                # Inspect a sample or all to see if we satisfy K
                # We need to do a lightweight check against the DB to see if they pass filters
                # Optimization: Only check if we haven't reached "Hard Limit"
                if len(res) < k: 
                    # Even vector store didn't find enough
                    break
                
                # Identify IDs to check
                cids = [r["id"] for r in res]
                
                # Lightweight check
                placeholders = ",".join(["?"] * len(cids))
                
                # Build filter clause for SQL check
                clauses = ["id IN ({})".format(placeholders)]
                params = list(cids)
                
                if f.get("startTime"):
                    clauses.append("created_at >= ?")
                    params.append(f["startTime"])
                if f.get("endTime"):
                    clauses.append("created_at <= ?")
                    params.append(f["endTime"])
                if f.get("minSalience"):
                    clauses.append("salience >= ?")
                    params.append(f["minSalience"])
                    
                cond = " AND ".join(clauses)
                
                # We count how many satisfy
                valid_count_res = await db.async_fetchone(f"SELECT COUNT(*) as c FROM {q.tables['memories']} WHERE {cond}", tuple(params))
                valid_count = valid_count_res["c"] if valid_count_res else 0
                
                if valid_count >= k:
                    # We have enough
                    break
                    
                if len(res) < req_k:
                    # Store exhausted (returned fewer than we asked)
                    break
                    
                # Expand
                multiplier *= 2
                if multiplier > 60: # Max cap (approx 300-600 candidates for K=10)
                    logger.warning(f"[HSG] Query expansion hit limit {multiplier}x for sector {s}")
                    break
            
            sr[s] = [{"id": r["id"], "similarity": r["score"]} for r in res]

        all_sims = []
        for s, slist in sr.items():
            for x in slist[:8]:
                all_sims.append(x["similarity"])

        avg_top = sum(all_sims)/len(all_sims) if all_sims else 0
        adapt_exp = math.ceil(0.3 * k * (1 - avg_top))
        eff_k = k + adapt_exp
        high_conf = avg_top >= 0.55

        ids = set()
        for s, res in sr.items():
            for r in res: ids.add(r["id"])

        exp = []
        if not high_conf:
            exp = await expand_via_waypoints(list(ids), k*2, user_id=f.get("user_id"))
            for e in exp: ids.add(e["id"])

        # Bulk fetch memory rows for all candidates to avoid N+1 queries early
        if not ids: return []

        t = q.tables
        placeholders = ",".join(["?"] * len(ids))
        m_rows = await db.async_fetchall(f"SELECT * FROM {t['memories']} WHERE id IN ({placeholders})", tuple(ids))
        m_map = {m["id"]: m for m in m_rows}

        kw_scores = {}
        if env.tier == "hybrid":
            for mid in ids:
                m = m_map.get(mid)
                if m:
                    overlap = compute_keyword_overlap(qt, m["content"])  # type: ignore
                    kw_scores[mid] = overlap * (env.keyword_boost or 0.15)

        # Bulk fetch ALL vectors for candidate IDs to avoid N+1 in fusion
        all_vecs_map = await store.getVectorsByMultipleIds(list(ids), user_id=f.get("user_id"))

        res_list = []
        now_ts = int(time.time() * 1000)
        for mid in ids:
            m = m_map.get(mid)
            if not m: continue
            if f.get("minSalience") and m["salience"] < f["minSalience"]: continue
            if f.get("user_id") and m["user_id"] != f["user_id"]: continue
            if f.get("startTime") and m["created_at"] < f["startTime"]: continue
            if f.get("endTime") and m["created_at"] > f["endTime"]: continue

            # Pass pre-fetched vectors to fusion score
            v_list = all_vecs_map.get(mid, [])
            mvf = await calc_multi_vec_fusion_score(mid, qe, w, pre_fetched_vecs=v_list)
            csr = await calculateCrossSectorResonanceScore(m["primary_sector"], qc["primary"], mvf)

            best_sim = csr
            for s, rlist in sr.items():
                for r in rlist:
                    if r["id"] == mid and r["similarity"] > best_sim: best_sim = r["similarity"]

            # Penalty
            mem_sec = m["primary_sector"]
            q_sec = qc["primary"]
            penalty = 1.0
            # If not in query primary sectors list, apply relationship penalty
            if mem_sec != q_sec and mem_sec not in primary_sectors:
                penalty = SECTOR_RELATIONSHIPS.get(q_sec, {}).get(mem_sec, 0.3)

            adj = best_sim * penalty

            # Retrieve expansion data if available
            em = next((e for e in exp if e["id"] == mid), None)
            ww = min(1.0, max(0.0, em["weight"] if em else 0.0))
            path = em["path"] if em else [mid]

            ds = (now_ts - m["last_seen_at"]) / 86400000.0
            sal = calc_decay(m["primary_sector"], m["salience"], ds)
            mtk = canonical_token_set(m["content"])
            tok_ov = compute_token_overlap(qtk, mtk)
            rec_sc = calc_recency_score_decay(m["last_seen_at"])
            tag_match = compute_tag_match_score_sync(m.get("tags"), qtk)

            debug_obj = {
                "sim_adj": adj,
                "tok_ov": tok_ov,
                "recency": rec_sc,
                "waypoint": ww,
                "tag": tag_match,
                "penalty": penalty
            }

            # Populate trace
            trace_obj = {
                "justification": generate_trace(debug_obj, m["primary_sector"]),
                "metrics": debug_obj,
                "path": path
            }

            fs = compute_hybrid_score(adj, tok_ov, ww, rec_sc, kw_scores.get(mid, 0), tag_match)

            # Sector consistency fix: get all sectors for this memory
            # In a real implementation we'd join with vectors table, but for performance
            # we'll assume primary + potentially meta. If we had more info we'd list them.
            # For now, let's at least ensure it's a list.

            # Construct MemoryItem with path
            meta_parsed = safe_json_loads(m.get("metadata") or m.get("meta"), {})
            tags_parsed = safe_json_loads(m.get("tags"), [])
            
            item = MemoryItem(
                id=mid,
                content=get_encryption().decrypt(m["content"]),
                score=fs,
                primary_sector=m["primary_sector"],
                sectors=list(set([m["primary_sector"]] + meta_parsed.get("additional_sectors", []))),
                salience=sal,
                created_at=m["created_at"],
                updated_at=m["updated_at"],
                last_seen_at=m["last_seen_at"],
                tags=tags_parsed,
                metadata=meta_parsed,
                decay_lambda=m["decay_lambda"],
                version=m["version"],
                segment=m["segment"],
                simhash=m["simhash"],
                generated_summary=m["generated_summary"],
                feedback_score=m["feedback_score"] or 0.0,
                trace=trace_obj,
                user_id=m["user_id"]
            )
            item.path = path # Attach path for reinforcement

            if f.get("debug"):
                item.debug = debug_obj

            res_list.append(item)

        res_list.sort(key=lambda x: x.score, reverse=True)
        top_cands = res_list[:eff_k]

        # Z-score normalization for results (matching JS line 915)
        if top_cands:
            scores = [r.score for r in top_cands]
            mean_sc = sum(scores) / len(scores)
            var = sum((s - mean_sc)**2 for s in scores) / len(scores)
            std = math.sqrt(var) + HYBRID_PARAMS["epsilon"]
            for r in top_cands:
                r.score = (r.score - mean_sc) / std
            top_cands.sort(key=lambda x: x.score, reverse=True)

        top = top_cands[:k]
        tids = [r.id for r in top]
        coact_buf = []

        # Update feedback scores (EMA) and reinforcement
        for r in top:
            # EMA update for feedback_score - using cached value
            cur_fb = r.feedback_score
            new_fb = cur_fb * 0.9 + r.score * 0.1
            await q.upd_feedback(r.id, new_fb, user_id=f.get("user_id"))

            # Co-activation buffer
            uid = f.get("user_id") or "anonymous"
            for other_id in tids:
                if r.id < other_id:  # ensure unique pairs
                    hsg_state.coact_buf.append((uid, r.id, other_id))

            rsal = await applyRetrievalTraceReinforcementToMemory(r.id, r.salience)
            await q.upd_seen(r.id, now_ts, rsal, now_ts, user_id=f.get("user_id"))

            # Propagate to Linked Nodes
            propagated_count = 0
            if r.path and len(r.path) > 1:
                ctx_uid = f.get("user_id")
                propagated_count = await _propagate_reinforcement(r.id, rsal, r.salience, r.path, ctx_uid, now_ts)

            await on_query_hit(
                r.id, r.primary_sector, lambda t: embed_for_sector(t, r.primary_sector, user_id=f.get("user_id"))
            )

        await db.async_commit()
        trigger_coactivation_sync() # trigger worker

        hsg_state.purge_cache()
        hsg_state.cache[cache_key] = {"r": top, "t": time.time()*1000}
        return top

    finally:
        dec_q()


async def reinforce_memory(mid: str, boost: float = 0.1, user_id: Optional[str] = None) -> Dict[str, Any]:
    """Manually reinforce a memory's salience."""
    now = int(time.time() * 1000)
    
    async with transaction():
        mem = await q.get_mem(mid, user_id)
        if not mem:
            return {"ok": False, "error": "Not Found"}

        new_sal = min(1.0, (mem["salience"] or 0) + boost)

        t = q.tables
        user_clause = "AND user_id=?" if user_id else ""
        params = (new_sal, now, now, mid) + ((user_id,) if user_id else ())
        await db.async_execute(
            f"UPDATE {t['memories']} SET salience=?, last_seen_at=?, updated_at=? WHERE id=? {user_clause}",
            params,
        )

        # Propagate to linked nodes
        # We don't have a path here, so we just propagate to immediate neighbors
        propagated_count = await _propagate_reinforcement(mid, new_sal, mem["salience"], [], user_id, now)

        # Trigger learning/decay update if applicable
        await on_query_hit(mid, mem["primary_sector"], lambda t: embed_for_sector(t, mem["primary_sector"], user_id=mem["user_id"]))

        return {
            "success": True, 
            "propagatedCount": propagated_count, 
            "newSalience": new_sal,
            "id": mid
        }

async def _propagate_reinforcement(mid: str, new_sal: float, old_sal: float, path: List[str], user_id: Optional[str], now_ts: int) -> int:
    """Helper to propagate reinforcement to linked nodes."""
    total_propagated = 0
    if path and len(path) > 1:
        await reinforce_waypoints(path, user_id or "anonymous")
    
    t = q.tables
    wps_rows = await db.async_fetchall(
        f"SELECT dst_id, weight FROM {t['waypoints']} WHERE src_id=? AND (user_id=? OR (user_id IS NULL AND ? IS NULL))",
        (mid, user_id, user_id),
    )
    wps = [
        {"target_id": row["dst_id"], "weight": row["weight"]}
        for row in wps_rows
    ]

    pru = await propagateAssociativeReinforcementToLinkedNodes(
        mid, new_sal, wps, user_id
    )
    
    if pru:
        ln_ids = [u["node_id"] for u in pru]
        placeholders = ",".join(["?"] * len(ln_ids))
        ln_mems = await db.async_fetchall(
            f"SELECT id, salience, last_seen_at FROM {t['memories']} WHERE id IN ({placeholders})",
            tuple(ln_ids),
        )
        ln_map = {m["id"]: m for m in ln_mems}

        # Batch calculation
        update_params = []
        for u in pru:
            linked_mem = ln_map.get(u["node_id"])
            if linked_mem:
                time_diff = (now_ts - (linked_mem["last_seen_at"] or now_ts)) / 86400000.0
                decay_fact = math.exp(-0.02 * time_diff)
                ctx_boost = HYBRID_PARAMS["gamma"] * (new_sal - old_sal) * decay_fact
                upd_sal = max(0.0, min(1.0, linked_mem["salience"] + ctx_boost))
                
                # params: salience, last_seen_at, updated_at, id
                update_params.append((upd_sal, now_ts, now_ts, u["node_id"]))
                total_propagated += 1

        if update_params:
            await db.async_executemany(
                f"UPDATE {t['memories']} SET salience=?, last_seen_at=?, updated_at=? WHERE id=?",
                update_params
            )
    
    return total_propagated

