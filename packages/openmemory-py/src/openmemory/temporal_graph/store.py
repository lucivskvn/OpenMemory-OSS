"""
Audited: 2026-01-19
"""
import time
import uuid
import json
import logging
from typing import List, Dict, Any, Optional

from ..core.db import q, db

# Port of backend/src/temporal_graph/store.ts

logger = logging.getLogger("temporal")


async def insert_fact(
    subject: str,
    predicate: str,
    fact_object: str,
    validFrom: Optional[int] = None,
    confidence: float = 1.0,
    metadata: Optional[Dict[str, Any]] = None,
    userId: Optional[str] = None,
    user_id: Optional[str] = None,
    valid_from: Optional[int] = None,
) -> str:
    # args...
    vf = validFrom if validFrom is not None else valid_from
    async with db.transaction():
        return await _insert_fact_core(
            subject, predicate, fact_object, vf, confidence, metadata, userId=userId or user_id
        )


async def _insert_fact_core(
    subject: str,
    predicate: str,
    fact_object: str,
    validFrom: Optional[int] = None,
    confidence: float = 1.0,
    metadata: Optional[Dict[str, Any]] = None,
    userId: Optional[str] = None,
) -> str:
    # fact_object -> "object" column (object is reserved word in python)
    fact_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    validFromTs = validFrom if validFrom is not None else now

    t = q.tables
    uid = userId # Normalize logic handled in repository if exists, but here we use it directly

    # Integrity: Fetch existing overlapping facts to enforce Cardinality 1 (Single-Value Predicates)
    user_clause = "AND user_id = ?" if uid else "AND user_id IS NULL"
    user_param = (uid,) if uid else ()

    for_update = " FOR UPDATE" if db.is_pg else ""
    # JS uses: (valid_to IS NULL OR valid_to >= ?) ORDER BY valid_from ASC
    sql = f"""
        SELECT id, valid_from, valid_to 
        FROM {t['temporal_facts']} 
        WHERE subject=? AND predicate=? {user_clause} 
        AND (valid_to IS NULL OR valid_to >= ?) 
        ORDER BY valid_from ASC {for_update}
    """
    existing = await db.async_fetchall(sql, (subject, predicate) + user_param + (validFromTs,))

    newFactValidTo = None

    for old in existing:
        oldValidFrom = int(old["valid_from"])
        
        if oldValidFrom < validFromTs:
            # Existing fact started before the new one -> close it
            await db.async_execute(
                f"UPDATE {t['temporal_facts']} SET valid_to=?, last_updated=? WHERE id=?",
                (validFromTs - 1, now, old["id"]),
            )
            logger.debug(f"[TEMPORAL] Closed fact {old['id']}")
        elif oldValidFrom == validFromTs:
            # Collision: existing fact starts at same time -> invalidate it completely
            await db.async_execute(
                f"UPDATE {t['temporal_facts']} SET valid_to=?, last_updated=? WHERE id=?",
                (validFromTs - 1, now, old["id"]),
            )
            logger.debug(f"[TEMPORAL] Collided fact {old['id']} invalidated")
        elif oldValidFrom > validFromTs:
            # Future fact exists -> cap the new fact's validity to start of next one
            if newFactValidTo is None or oldValidFrom - 1 < newFactValidTo:
                newFactValidTo = oldValidFrom - 1

    meta_json = json.dumps(metadata) if metadata else None

    await db.async_execute(
        f"INSERT INTO {t['temporal_facts']}(id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            fact_id,
            uid,
            subject,
            predicate,
            fact_object,
            validFromTs,
            newFactValidTo,
            confidence,
            now,
            meta_json,
        ),
    )

    return fact_id


async def update_fact(
    fact_id: str,
    userId: str,
    confidence: Optional[float] = None,
    metadata: Optional[Dict[str, Any]] = None,
):
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
    params.append(userId)

    t = q.tables
    sql = (
        f"UPDATE {t['temporal_facts']} SET {', '.join(updates)} WHERE id=? AND user_id=?"
    )
    async with db.transaction():
        await db.async_execute(sql, tuple(params))


async def invalidate_fact(fact_id: str, userId: str, validTo: Optional[int] = None):
    """Mark a fact as no longer valid from validTo timestamp."""
    ts = validTo if validTo is not None else int(time.time() * 1000)
    t = q.tables
    async with db.transaction():
        await db.async_execute(
            f"UPDATE {t['temporal_facts']} SET valid_to=?, last_updated=? WHERE id=? AND user_id=?",
            (ts, int(time.time() * 1000), fact_id, userId),
        )


async def delete_fact(fact_id: str, userId: str):
    """Hard delete a fact and its related edges."""
    t = q.tables
    async with db.transaction():
        await db.async_execute(
            f"DELETE FROM {t['temporal_facts']} WHERE id=? AND user_id=?",
            (fact_id, userId),
        )
        # Also delete related edges (orphans)
        await db.async_execute(
            f"DELETE FROM {t['temporal_edges']} WHERE (source_id=? OR target_id=?) AND user_id=?",
            (fact_id, fact_id, userId),
        )


async def insert_edge(
    sourceId: str,
    targetId: str,
    relationType: str,
    validFrom: Optional[int] = None,
    weight: float = 1.0,
    metadata: Optional[Dict[str, Any]] = None,
    userId: Optional[str] = None,
    user_id: Optional[str] = None,
    commit: bool = True,
    valid_from: Optional[int] = None,
) -> str:
    """Insert a new temporal edge between two facts."""
    uid = userId or user_id
    edge_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    vf = validFrom if validFrom is not None else valid_from
    validFromTs = vf if vf is not None else now
    t = q.tables

    async with db.transaction():
        # Invalidate existing edges of same type between same nodes
        user_clause = "AND user_id = ?" if uid else "AND user_id IS NULL"
        user_param = (uid,) if uid else ()

        # insert_edge SELECT
        for_update = " FOR UPDATE" if db.is_pg else ""
        sql = f"""
            SELECT id, valid_from 
            FROM {t['temporal_edges']} 
            WHERE source_id=? AND target_id=? AND relation_type=? {user_clause} 
            AND valid_to IS NULL {for_update}
        """
        existing = await db.async_fetchall(sql, (sourceId, targetId, relationType) + user_param)

        for old in existing:
            oldValidFrom = int(old["valid_from"])
            if oldValidFrom < validFromTs:
                logger.debug(f"[TEMPORAL] Closing old edge {old['id']}")
                await db.async_execute(
                    f"UPDATE {t['temporal_edges']} SET valid_to=?, last_updated=? WHERE id=?",
                    (validFromTs - 1, now, old["id"]),
                )
            elif oldValidFrom == validFromTs:
                logger.debug(f"[TEMPORAL] Collided edge {old['id']} invalidated")
                await db.async_execute(
                    f"UPDATE {t['temporal_edges']} SET valid_to=?, last_updated=? WHERE id=?",
                    (validFromTs - 1, now, old["id"]),
                )

        meta_json = json.dumps(metadata) if metadata else None

        await db.async_execute(
            f"INSERT INTO {t['temporal_edges']}(id, user_id, source_id, target_id, relation_type, valid_from, valid_to, weight, last_updated, metadata) VALUES (?,?,?,?,?,?,NULL,?,?,?)",
            (
                edge_id,
                uid,
                sourceId,
                targetId,
                relationType,
                validFromTs,
                weight,
                now,
                meta_json,
            ),
        )
    return edge_id


async def invalidate_edge(edge_id: str, userId: str, validTo: Optional[int] = None):
    """Mark an edge as no longer valid."""
    ts = validTo if validTo is not None else int(time.time() * 1000)
    t = q.tables
    async with db.transaction():
        await db.async_execute(
            f"UPDATE {t['temporal_edges']} SET valid_to=? WHERE id=? AND user_id=?",
            (ts, edge_id, userId),
        )


# ... batch_insert_facts is wrapper around insert_fact so it inherits fixes


async def batch_insert_facts(
    facts: List[Dict[str, Any]], userId: Optional[str] = None, user_id: Optional[str] = None
) -> List[str]:
    """
    Insert multiple temporal facts sequentially in a single transaction.
    """
    uid = userId or user_id
    ids = []
    async with db.transaction():
        for f in facts:
            fid = await _insert_fact_core(
                subject=f["subject"],
                predicate=f["predicate"],
                fact_object=f["object"],
                validFrom=f.get("validFrom"),
                confidence=f.get("confidence", 1.0),
                metadata=f.get("metadata"),
                userId=uid,
            )
            ids.append(fid)
    return ids


async def batch_insert_edges(
    edges: List[Dict[str, Any]], userId: Optional[str] = None, user_id: Optional[str] = None
) -> List[str]:
    """
    Insert multiple temporal edges sequentially in a single transaction.
    """
    uid = userId or user_id
    ids = []
    async with db.transaction():
        for e in edges:
            eid = await insert_edge(
                sourceId=e["sourceId"],
                targetId=e["targetId"],
                relationType=e["relationType"],
                validFrom=e.get("validFrom"),
                weight=e.get("weight", 1.0),
                metadata=e.get("metadata"),
                userId=uid,
                commit=False,  # Legacy param, insert_edge handles its own transaction or joins current
            )
            ids.append(eid)
    return ids


async def apply_confidence_decay(decay_rate: float = 0.01) -> int:
    """Apply decay to confidence scores of all active facts."""
    now = int(time.time() * 1000)
    one_day = 86400000

    # Postgres uses GREATEST, SQLite uses MAX
    func = "GREATEST" if db.is_pg else "MAX"
    t = q.tables

    sql = f"""
        UPDATE {t['temporal_facts']}
        SET confidence = {func}(0.1, confidence * (1 - ? * ((? - valid_from) / ?)))
        WHERE valid_to IS NULL AND confidence > 0.1
    """
    async with db.transaction():
        cursor = await db.async_execute(sql, (decay_rate, now, one_day))
        return cursor.rowcount
