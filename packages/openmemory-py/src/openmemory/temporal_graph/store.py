import time
import uuid
import json
import logging
from typing import List, Dict, Any, Optional

from ..core.db import q, db

# Port of backend/src/temporal_graph/store.ts

logger = logging.getLogger("temporal")

async def insert_fact(subject: str, predicate: str, subject_object: str, valid_from: int = None, confidence: float = 1.0, metadata: Dict[str, Any] = None, user_id: Optional[str] = None, commit: bool = True) -> str:
    """
    Insert a new temporal fact.
    
    Args:
        subject: The subject of the fact.
        predicate: The relationship verb/type.
        subject_object: The object of the fact.
        valid_from: Timestamp (ms) when fact became true. Default: now.
        confidence: Confidence score (0.0-1.0).
        metadata: Optional metadata dict.
        user_id: Owner user ID.
        commit: Whether to commit transaction immediately.

    Returns:
        The UUID of the new fact.
    """
    # subject_object -> "object" column (object is reserved word in python)
    fact_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    valid_from_ts = valid_from if valid_from is not None else now
    
    async with db.transaction():
        # Invalidate existing
        user_clause = "AND user_id = ?" if user_id else "AND user_id IS NULL"
        user_param = (user_id,) if user_id else ()
        
        existing = await db.async_fetchall(f"SELECT id, valid_from FROM temporal_facts WHERE subject=? AND predicate=? {user_clause} AND valid_to IS NULL ORDER BY valid_from DESC", (subject, predicate) + user_param)
        
        for old in existing:
            if old["valid_from"] < valid_from_ts:
                logger.info(f"[Temporal] Invalidating old fact {old['id']} for {subject}.{predicate}")
                await db.async_execute("UPDATE temporal_facts SET valid_to=? WHERE id=?", (valid_from_ts - 1, old["id"]))
                
        meta_json = json.dumps(metadata) if metadata else None
        
        await db.async_execute("INSERT INTO temporal_facts(id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata) VALUES (?,?,?,?,?,?,NULL,?,?,?)",
                   (fact_id, user_id, subject, predicate, subject_object, valid_from_ts, confidence, now, meta_json))
    return fact_id

async def update_fact(fact_id: str, user_id: str, confidence: Optional[float] = None, metadata: Optional[Dict[str, Any]] = None):
    """Update metadata or confidence of an existing active fact."""
    updates = []
    params = []
    
    if confidence is not None:
        updates.append("confidence=?")
        params.append(confidence)
        
    if metadata is not None:
        updates.append("metadata=?")
        params.append(json.dumps(metadata))
        
    if not updates: return
    
    updates.append("last_updated=?")
    params.append(int(time.time() * 1000))
    params.append(fact_id)
    params.append(user_id)
    
    sql = f"UPDATE temporal_facts SET {', '.join(updates)} WHERE id=? AND user_id=?"
    await db.async_execute(sql, tuple(params))
    await db.async_commit()

async def invalidate_fact(fact_id: str, user_id: str, valid_to: int = None):
    """Mark a fact as no longer valid from valid_to timestamp."""
    ts = valid_to if valid_to is not None else int(time.time() * 1000)
    await db.async_execute("UPDATE temporal_facts SET valid_to=?, last_updated=? WHERE id=? AND user_id=?", (ts, int(time.time() * 1000), fact_id, user_id))
    await db.async_commit()
    
async def delete_fact(fact_id: str, user_id: str):
    """Hard delete a fact and its related edges."""
    async with db.transaction():
        await db.async_execute("DELETE FROM temporal_facts WHERE id=? AND user_id=?", (fact_id, user_id))
        # Also delete related edges (orphans)
        await db.async_execute("DELETE FROM temporal_edges WHERE (source_id=? OR target_id=?) AND user_id=?", (fact_id, fact_id, user_id))

async def insert_edge(source_id: str, target_id: str, relation_type: str, valid_from: int = None, weight: float = 1.0, metadata: Dict[str, Any] = None, user_id: Optional[str] = None, commit: bool = True) -> str:
    """Insert a new temporal edge between two facts."""
    edge_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    valid_from_ts = valid_from if valid_from is not None else now
    
    async with db.transaction():
        # Invalidate existing edges of same type between same nodes
        user_clause = "AND user_id = ?" if user_id else "AND user_id IS NULL"
        user_param = (user_id,) if user_id else ()
        
        existing = await db.async_fetchall(f"SELECT id, valid_from FROM temporal_edges WHERE source_id=? AND target_id=? AND relation_type=? {user_clause} AND valid_to IS NULL", (source_id, target_id, relation_type) + user_param)
        
        for old in existing:
            if old["valid_from"] < valid_from_ts:
                logger.info(f"[Temporal] Invalidating old edge {old['id']} between {source_id} and {target_id}")
                await db.async_execute("UPDATE temporal_edges SET valid_to=? WHERE id=?", (valid_from_ts - 1, old["id"]))

        meta_json = json.dumps(metadata) if metadata else None
        
        await db.async_execute("INSERT INTO temporal_edges(id, user_id, source_id, target_id, relation_type, valid_from, valid_to, weight, metadata) VALUES (?,?,?,?,?,?,NULL,?,?)",
                   (edge_id, user_id, source_id, target_id, relation_type, valid_from_ts, weight, meta_json))
    return edge_id

async def invalidate_edge(edge_id: str, user_id: str, valid_to: int = None):
    """Mark an edge as no longer valid."""
    ts = valid_to if valid_to is not None else int(time.time() * 1000)
    await db.async_execute("UPDATE temporal_edges SET valid_to=? WHERE id=? AND user_id=?", (ts, edge_id, user_id))
    await db.async_commit()

async def batch_insert_facts(facts: List[Dict[str, Any]]) -> List[str]:
    """Batch insert facts using a single transaction."""
    ids = []
    async with db.transaction():
        for f in facts:
            fid = await insert_fact(
                subject=f["subject"],
                predicate=f["predicate"],
                subject_object=f["object"],
                valid_from=f.get("valid_from"),
                confidence=f.get("confidence", 1.0),
                metadata=f.get("metadata"),
                user_id=f.get("user_id"),
                commit=False
            )
            ids.append(fid)
    return ids

async def apply_confidence_decay(decay_rate: float = 0.01) -> int:
    """Apply decay to confidence scores of all active facts."""
    now = int(time.time() * 1000)
    one_day = 86400000
    
    # Postgres uses GREATEST, SQLite uses MAX
    func = "GREATEST" if db.is_pg else "MAX"
    
    sql = f"""
        UPDATE temporal_facts 
        SET confidence = {func}(0.1, confidence * (1 - ? * ((? - valid_from) / ?)))
        WHERE valid_to IS NULL AND confidence > 0.1
    """
    cursor = await db.async_execute(sql, (decay_rate, now, one_day))
    await db.async_commit()
    return cursor.rowcount
