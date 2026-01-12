import logging
import json
import time
import asyncio
from typing import List, Optional, Dict, Any, Union, Set
from pydantic import ValidationError

from ..core.config import env
from ..core.db import db, q
from ..core.vector_store import vector_store
from ..core.types import (
    LgmStoreReq, LgStoreResult, LgmRetrieveReq, LgRetrieveResult,
    LgmContextReq, LgContextResult, LgNodeContext,
    LgmReflectionReq, LgReflectResult, MemoryItem, MemRow, GraphMemoryItem
)
from ..memory.hsg import add_hsg_memory, hsg_query

logger = logging.getLogger(__name__)

# Constants matching JS SDK
NODE_SECTOR_MAP = {
    "observe": "episodic",
    "plan": "semantic",
    "reflect": "reflective",
    "act": "procedural",
    "emotion": "emotional",
}
DEFAULT_SECTOR = "semantic"
SUMMARY_LINE_LIMIT = 160

# --- Helpers ---

def normalize_user_id(uid: Optional[str]) -> Optional[str]:
    if not uid: return None
    s = str(uid).strip()
    return s if s else None

def now() -> int:
    return int(time.time() * 1000)

def resolve_sector(node: str) -> str:
    return NODE_SECTOR_MAP.get(node.lower(), DEFAULT_SECTOR)

def resolve_ns(ns: Optional[str]) -> str:
    return ns or getattr(env, 'lg_namespace', 'default')

def stringify_json(val: Any) -> str:
    if isinstance(val, str): return val
    return json.dumps(val)

def parse_json_safe(val: Any, default: Any) -> Any:
    if val is None: return default
    if isinstance(val, (dict, list)): return val
    try:
        return json.loads(str(val))
    except (json.JSONDecodeError, TypeError):
        return default

def trunc(txt: str, max_len: int = 320) -> str:
    if len(txt) <= max_len: return txt
    return txt[:max_len].rstrip() + "..."

def build_tags(tags: Optional[List[str]], node: str, ns: str, gid: Optional[str] = None) -> List[str]:
    ts = set(tags or [])
    ts.add(f"lgm:node:{node.lower()}")
    ts.add(f"lgm:namespace:{ns}")
    if gid:
        ts.add(f"lgm:graph:{gid}")
    return list(ts)

def build_meta(p: LgmStoreReq, sec: str, ns: str, ext: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    base = (p.metadata or {}).copy()
    ex_lgm = base.get("lgm") or {}

    base["lgm"] = {
        **ex_lgm,
        "node": p.node.lower(),
        "sector": sec,
        "namespace": ns,
        "graphId": p.graphId,  # type: ignore[attr-defined]
        "storedAt": now(),
        "mode": "langgraph",
        **(ext or {}),
    }
    base["sector"] = sec
    return base

def matches_ns(meta: Dict[str, Any], ns: str, gid: Optional[str]) -> bool:
    lgm = meta.get("lgm")
    if not lgm or not isinstance(lgm, dict): return False
    if lgm.get("namespace") != ns: return False
    if gid and lgm.get("graphId") != gid: return False
    return True

async def get_mems_by_tag(sector: str, tag: str, limit: int, offset: int, user_id: Optional[str]) -> List[MemRow]:
    t = q.tables
    sql = f"""
        SELECT * FROM {t['memories']}
        WHERE primary_sector = $1
        AND tags LIKE $2
    """
    params: List[Any] = [sector, f"%{tag}%"]

    idx = 3
    if user_id:
        sql += f" AND user_id = ${idx}"
        params.append(user_id)
        idx += 1

    sql += f" ORDER BY last_seen_at DESC LIMIT ${idx} OFFSET ${idx+1}"
    params.extend([limit, offset])

    rows = await db.async_fetchall(sql, tuple(params))
    return [MemRow(**r) for r in rows]

async def create_auto_refl(p: LgmStoreReq, stored_id: str, ns: str) -> Optional[MemoryItem]:
    gid = p.graph_id  # type: ignore[attr-defined]  # type: ignore[attr-defined]
    refl_tags = build_tags(
        ["lgm:auto:reflection", f"lgm:source:{stored_id}"],
        "reflect", ns, gid
    )
    refl_meta = {
        "lgm": {
            "node": "reflect",
            "sector": "reflective",
            "namespace": ns,
            "graphId": gid,
            "storedAt": now(),
            "mode": "langgraph",
            "sourceMemory": stored_id,
            "sourceNode": p.node.lower(),
        },
        "sector": "reflective"
    }

    parts = [
        f'LangGraph reflection for node "{p.node}"',
        f'namespace={ns}'
    ]
    if gid: parts.append(f'graph={gid}')

    content = f"{' | '.join(parts)}\n\n{trunc(p.content, 480)}"

    res = await add_hsg_memory(
        content=content,
        tags=stringify_json(refl_tags),
        metadata=refl_meta,
        user_id=normalize_user_id(p.user_id)  # type: ignore[attr-defined]  # type: ignore[attr-defined]
    )

    return MemoryItem(  # type: ignore[call-arg]
        id=res["id"],
        content=res["content"],
        primary_sector=res["primary_sector"],  # type: ignore[call-arg]
        sectors=res["sectors"],
        created_at=now(),  # type: ignore[call-arg]
        updated_at=now(),  # type: ignore[call-arg]
        tags=refl_tags,
        metadata=refl_meta,  # type: ignore[call-arg]
        salience=res.get("salience", 0.5)
    )

async def store_node_mem(p: LgmStoreReq) -> LgStoreResult:
    if not p.node or not p.content:
        raise ValueError("node and content are required")

    ns = resolve_ns(p.namespace)
    node = p.node.lower()
    sec = resolve_sector(node)
    tag_list = build_tags(p.tags, node, ns, p.graphId)  # type: ignore[arg-type]
    meta = build_meta(p, sec, ns)
    user_id = normalize_user_id(p.userId)  # type: ignore[arg-type]

    res = await add_hsg_memory(
        content=p.content,
        tags=stringify_json(tag_list),
        metadata=meta,
        user_id=user_id
    )

    stored = GraphMemoryItem(  # type: ignore[call-arg]
        id=res["id"],
        content=p.content,
        primary_sector=res["primary_sector"],  # type: ignore[call-arg]
        sectors=res["sectors"],
        node=node,
        tags=tag_list,
        metadata=meta,  # type: ignore[call-arg]
        created_at=res["created_at"],  # type: ignore[call-arg]
        updated_at=res["created_at"],  # type: ignore[call-arg]
        last_seen_at=res["created_at"],  # type: ignore[call-arg]
        salience=res.get("salience", 0.5),
        user_id=user_id,  # type: ignore[call-arg]
        simhash=res.get("simhash"),
        generated_summary=res.get("generated_summary")  # type: ignore[call-arg]
    )

    refl_enabled = getattr(env, 'lg_reflective', False)
    if p.reflective is not None:
        refl_enabled = p.reflective

    refl_id = None
    if refl_enabled and node != "reflect":
        refl_item = await create_auto_refl(p, res["id"], ns)
        if refl_item:
            refl_id = refl_item.id

    return LgStoreResult(  # type: ignore[call-arg]
        success=True,
        memory_id=res["id"],  # type: ignore[call-arg]
        node=node,
        memory=stored
        # reflection_id not in LgStoreResult type currently
    )

async def retrieve_node_mems(p: LgmRetrieveReq) -> LgRetrieveResult:  # type: ignore[return]
    if not p.node: raise ValueError("node is required")

    ns = resolve_ns(p.namespace)
    node = p.node.lower()
    sec = resolve_sector(node)
    limit = p.limit or getattr(env, 'lg_max_context', 50)
    inc_meta = p.include_metadata or False
    gid = p.graph_id  # type: ignore[attr-defined]  # type: ignore[attr-defined]
    user_id = normalize_user_id(p.user_id)  # type: ignore[attr-defined]  # type: ignore[attr-defined]

    items: List[GraphMemoryItem] = []

    if p.query:
        # HSG Query
        matches = await hsg_query(
            p.query,
            k=limit * 2,
            filters={  # type: ignore[arg-type]
                "sectors": [sec],
                "user_id": user_id
            }
        )
        for m in matches:
             m_meta = m.get("metadata") or {}
             # Simple metadata parsing if str
             if isinstance(m_meta, str):
                 m_meta = parse_json_safe(m_meta, {})

             if not matches_ns(m_meta, ns, gid): continue

             hyd = GraphMemoryItem(  # type: ignore[call-arg]
                 id=m["id"],
                 content=m["content"],
                 primary_sector=m["primary_sector"],  # type: ignore[call-arg]
                 sectors=m.get("sectors", [m["primary_sector"]]),
                 node=node,
                 tags=parse_json_safe(m.get("tags"), []),
                 metadata=m_meta if inc_meta else {},  # type: ignore[call-arg]
                 created_at=m["created_at"],  # type: ignore[call-arg]
                 updated_at=m.get("updated_at", 0),  # type: ignore[call-arg]
                 last_seen_at=m.get("last_seen_at", 0),  # type: ignore[call-arg]
                 salience=m.get("salience", 0.5),
                 user_id=m.get("user_id"),  # type: ignore[call-arg]
                 score=m.get("score"),
                 path=m.get("path")
             )
             items.append(hyd)
             if len(items) >= limit: break
    else:
        # Tag search
        rows = await get_mems_by_tag(sec, f"lgm:namespace:{ns}", limit * 4, 0, user_id)
        for row in rows:
            # metadata in MemRow is Optional[str]
            row_meta = parse_json_safe(row.metadata  # type: ignore[attr-defined], {})  # type: ignore[possibly-unbound]
            if not matches_ns(row_meta, ns, gid):  # type: ignore[possibly-unbound]
                continue

            hyd = GraphMemoryItem(  # type: ignore[call-arg]
                 id=row.id,
                 content=row.content,
                 primary_sector=row.primary_sector,  # type: ignore[call-arg]
                 sectors=[row.primary_sector],
                 node=node,
                 tags=parse_json_safe(row.tags, []),
                 metadata=row_meta if inc_meta else {},  # type: ignore[call-arg]
                 created_at=row.created_at,  # type: ignore[call-arg]
                 updated_at=row.updated_at,  # type: ignore[call-arg]
                 last_seen_at=row.last_seen_at,  # type: ignore[call-arg]
                 salience=row.salience,
                 user_id=row.user_id,  # type: ignore[call-arg]
                 simhash=row.simhash,
                 generated_summary=row.generated_summary  # type: ignore[call-arg]
            )
            items.append(hyd)
            if len(items) >= limit: break

    return LgRetrieveResult(
        success=True,
        memories=items
    )

async def get_graph_ctx(p: LgmContextReq) -> LgContextResult:
    ns = resolve_ns(p.namespace)
    limit = p.limit or getattr(env, 'lg_max_context', 50) # Assuming small context window

    nodes = list(NODE_SECTOR_MAP.keys())
    per_node_limit = max(1, (limit // len(nodes)) or 1)

    tasks = []
    for n in nodes:
        req = LgmRetrieveReq(
            node=n,
            namespace=ns,
            graph_id=p.graph_id,
            limit=per_node_limit,
            include_metadata=True,
            user_id=p.user_id
        )
        tasks.append(retrieve_node_mems(req))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    node_ctxs: List[LgNodeContext] = []
    for i, res in enumerate(results):
        if isinstance(res, Exception):
            logger.warning(f"Failed to retrieve context for node {nodes[i]}: {res}")
            continue
        if isinstance(res, LgRetrieveResult) and res.success:
             # LgNodeContext expects 'items' (List[MemoryItem]).
             # LgRetrieveResult.memories is List[MemoryItem] (GraphMemoryItem is MemoryItem)
             if res.memories:
                 node_ctxs.append(LgNodeContext(
                     node=nodes[i],
                     items=res.memories
                 ))

    # Flatten summaries
    flat_lines = []
    for nc in node_ctxs:
        for m in nc.items:
            flat_lines.append(f"- [{nc.node}] {trunc(m.content, SUMMARY_LINE_LIMIT)}")

    summ = "\n".join(flat_lines[:limit])

    return LgContextResult(  # type: ignore[call-arg]  # type: ignore[call-arg]
        success=True,
        context=summ,
        nodes=node_ctxs,
        query="" # LgContextResult doesn't typically have query but check type?
        # types.py: class LgContextResult(BaseModel): success, context, nodes.
        # It does NOT have query field in snippet I saw.
    )

async def create_refl(p: LgmReflectionReq) -> LgReflectResult:
    ns = resolve_ns(p.namespace)
    node = (p.node or "reflect").lower()

    # If content missing, synthesize from context?
    # JS logic: if !content, buildCtxRefl (calls getGraphCtx).
    content = p.content
    if not content:
        # Auto synthesize
        ctx_res = await get_graph_ctx(LgmContextReq(
            namespace=ns,
            graph_id=p.graph_id,
            user_id=p.user_id
        ))
        if ctx_res.context:
            hdr = f"Reflection synthesized from LangGraph context (namespace={ns})"
            content = f"{hdr}\n\n{ctx_res.context}"

    if not content:
        raise ValueError("reflection content could not be derived")

    tags = ["lgm:manual:reflection"]
    if p.context_ids:
        tags.extend([f"lgm:context:{cid}" for cid in p.context_ids])

    meta = {
        "lgmContextIds": p.context_ids or []
    }

    store_req = LgmStoreReq(
        node=node,
        content=content,
        namespace=ns,
        graph_id=p.graph_id,
        tags=tags,
        metadata=meta,
        reflective=False,
        user_id=p.user_id
    )

    res = await store_node_mem(store_req)

    return LgReflectResult(
        success=res.success,
        reflection_id=res.memory_id,
        insights=[content[:100]] # Simple insight
    )

async def get_thread_history(p: LgmRetrieveReq) -> Dict[str, Any]:
    """
    Get linear history of a graph execution thread.
    Returns format matching JS: { namespace, graphId, userId, count, history: [...] }
    """
    ns = resolve_ns(p.namespace)
    if not p.graph_id:
        raise ValueError("graphId required for history")

    user_id = normalize_user_id(p.user_id)  # type: ignore[attr-defined]  # type: ignore[attr-defined]
    nodes = list(NODE_SECTOR_MAP.keys())

    tasks = []
    for n in nodes:
        # Check if we should use p.limit? JS hardcodes 100 for history per node.
        # JS: limit: 100
        req = LgmRetrieveReq(
            node=n,
            namespace=ns,
            graph_id=p.graph_id,
            limit=100,
            user_id=user_id
        )
        tasks.append(retrieve_node_mems(req))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    all_items: List[GraphMemoryItem] = []

    for i, res in enumerate(results):
        if isinstance(res, Exception):
            logger.warning(f"Failed to retrieve history for node {nodes[i]}: {res}")
            continue
        if isinstance(res, LgRetrieveResult) and res.success:
            # We need to ensure we're getting GraphMemoryItems.
            # In python strict typing, LgRetrieveResult.memories is List[GraphMemoryItem] (runtime)
            # strictly typed as List[MemoryItem] in Pydantic, but we instantiated GraphMemoryItem
            if res.memories:
                 # Filter or cast if needed, but they are GraphMemoryItem instances
                 all_items.extend([m for m in res.memories if isinstance(m, GraphMemoryItem)])

    # Sort by createdAt ascending (JS: a.createdAt - b.createdAt)
    all_items.sort(key=lambda x: x.created_at)

    return {
        "namespace": ns,
        "graphId": p.graph_id,
        "userId": user_id,
        "count": len(all_items),
        "history": [
            {
                "id": i.id,
                "node": i.node,
                "content": i.content,
                "timestamp": time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(i.created_at/1000)),
                "metadata": i.metadata
            }
            for i in all_items
        ]
    }

def get_lg_cfg() -> Dict[str, Any]:
    """Get langgraph configuration."""
        "success": True,
        "config": {
            "nodes": list(NODE_SECTOR_MAP.keys()),
            "edges": []
        }
    }
