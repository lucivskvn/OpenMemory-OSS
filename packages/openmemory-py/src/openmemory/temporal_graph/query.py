import time
import json
import logging
from typing import List, Dict, Any, Optional

from ..core.db import db, q
from ..core.types import TemporalFact, TemporalEdge

# Port of backend/src/temporal_graph/query.ts


async def query_facts_at_time(
    subject: Optional[str] = None,
    predicate: Optional[str] = None,
    fact_object: Optional[str] = None,
    at: Optional[int] = None,
    minConfidence: float = 0.1,
    userId: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Query facts that were active at a specific point in time.

    Args:
        subject: Optional subject filter.
        predicate: Optional predicate filter.
        fact_object: Optional object filter.
        at: Timestamp (ms). Default: now.
        minConfidence: Minimum confidence score.
        userId: Owner user ID.

    Returns:
        List of matching TemporalFact dicts.
    """
    ts = at if at is not None else int(time.time()*1000)
    conds = ["(validFrom <= ? AND (validTo IS NULL OR validTo >= ?))"]
    params = [ts, ts]

    if subject:
        conds.append("subject = ?")
        params.append(subject)  # type: ignore[arg-type]
    if predicate:
        conds.append("predicate = ?")
        params.append(predicate)  # type: ignore[arg-type]
    if fact_object:
        conds.append("object = ?")
        params.append(fact_object)  # type: ignore[arg-type]
    if minConfidence > 0:
        conds.append("confidence >= ?")
        params.append(minConfidence)  # type: ignore[arg-type]
    if userId:
        conds.append("userId = ?")
        params.append(userId)  # type: ignore[arg-type]

    t = q.tables
    sql = f"""
        SELECT id, userId, subject, predicate, object, validFrom, validTo, confidence, lastUpdated, metadata
        FROM {t['temporal_facts']}
        WHERE {' AND '.join(conds)}
        ORDER BY confidence DESC, validFrom DESC
    """
    rows = await db.async_fetchall(sql, tuple(params))
    return [format_fact(r) for r in rows]


async def get_current_fact(
    subject: str, predicate: str, userId: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Get the currently active fact for a subject and predicate.

    Args:
        subject: The subject to query.
        predicate: The predicate to query.
        userId: Owner user ID.

    Returns:
        The active TemporalFact or None.
    """
    user_clause = "AND userId = ?" if userId else ""
    params = (subject, predicate, userId) if userId else (subject, predicate)

    t = q.tables
    sql = f"""
        SELECT id, userId, subject, predicate, object, validFrom, validTo, confidence, lastUpdated, metadata
        FROM {t['temporal_facts']}
        WHERE subject = ? AND predicate = ? {user_clause} AND validTo IS NULL
        ORDER BY validFrom DESC
        LIMIT 1
    """
    row = await db.async_fetchone(sql, params)
    if not row: return None
    return format_fact(row)


async def query_facts_in_range(
    subject: Optional[str] = None,
    predicate: Optional[str] = None,
    start: Optional[int] = None,
    end: Optional[int] = None,
    minConfidence: float = 0.1,
    userId: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Query facts that were active at any point within a time range.

    Args:
        subject: Optional subject filter.
        predicate: Optional predicate filter.
        start: Start timestamp (ms).
        end: End timestamp (ms).
        minConfidence: Minimum confidence score.
        userId: Owner user ID.

    Returns:
        List of matching TemporalFact dicts.
    """
    conds = []
    params = []

    if start is not None and end is not None:
        # Overlap: (fact_start <= range_end) AND (fact_end IS NULL OR fact_end >= range_start)
        conds.append("(validFrom <= ? AND (validTo IS NULL OR validTo >= ?))")
        params.extend([end, start])
    elif start is not None:
        conds.append("validFrom >= ?")
        params.append(start)
    elif end is not None:
        conds.append("validFrom <= ?")
        params.append(end)

    if subject:
        conds.append("subject = ?")
        params.append(subject)
    if predicate:
        conds.append("predicate = ?")
        params.append(predicate)
    if minConfidence > 0:
        conds.append("confidence >= ?")
        params.append(minConfidence)
    if userId:
        conds.append("userId = ?")
        params.append(userId)

    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    t = q.tables
    sql = f"""
        SELECT id, userId, subject, predicate, object, validFrom, validTo, confidence, lastUpdated, metadata
        FROM {t['temporal_facts']}
        {where}
        ORDER BY validFrom DESC
    """
    rows = await db.async_fetchall(sql, tuple(params))
    return [format_fact(r) for r in rows]


async def find_conflicting_facts(
    subject: str,
    predicate: str,
    at: Optional[int] = None,
    userId: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Find all facts for a (subject, predicate) that were active at a point in time.
    Used for detecting conflicting knowledge.

    Args:
        subject: The subject to check.
        predicate: The predicate to check.
        at: Timestamp (ms) to check at.
        userId: Owner user ID.

    Returns:
        List of conflicting TemporalFact dicts.
    """
    ts = at if at is not None else int(time.time()*1000)
    user_clause = "AND userId = ?" if userId else ""
    params = (
        (subject, predicate, ts, ts, userId) if userId else (subject, predicate, ts, ts)
    )

    t = q.tables
    sql = f"""
        SELECT id, userId, subject, predicate, object, validFrom, validTo, confidence, lastUpdated, metadata
        FROM {t['temporal_facts']}
        WHERE subject = ? AND predicate = ?
        AND (validFrom <= ? AND (validTo IS NULL OR validTo >= ?))
        {user_clause}
        ORDER BY confidence DESC
    """
    rows = await db.async_fetchall(sql, params)
    return [format_fact(r) for r in rows]


async def get_facts_by_subject(
    subject: str,
    at: Optional[int] = None,
    include_historical: bool = False,
    userId: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Get all facts relating to a specific subject entity.

    Args:
        subject: The subject entity name.
        at: Optional timestamp to filter active facts.
        include_historical: If True, returns ended facts too.
        userId: Owner user ID.

    Returns:
        List of matching TemporalFact dicts.
    """
    user_clause = "AND userId = ?" if userId else ""
    params: List[Any] = [subject]
    if userId:
        params.append(userId)

    t = q.tables

    if include_historical:
        sql = f"""
            SELECT id, userId, subject, predicate, object, validFrom, validTo, confidence, lastUpdated, metadata
            FROM {t['temporal_facts']}
            WHERE subject = ? {user_clause}
            ORDER BY predicate ASC, validFrom DESC
        """
    else:
        ts = at if at is not None else int(time.time()*1000)
        sql = f"""
            SELECT id, userId, subject, predicate, object, validFrom, validTo, confidence, lastUpdated, metadata
            FROM {t['temporal_facts']}
            WHERE subject = ?
            AND (validFrom <= ? AND (validTo IS NULL OR validTo >= ?))
            {user_clause}
            ORDER BY predicate ASC, confidence DESC
        """
        params.insert(1, ts)
        params.insert(2, ts)

    rows = await db.async_fetchall(sql, tuple(params))
    return [format_fact(r) for r in rows]


async def search_facts(
    pattern: str,
    field: str = "subject",
    at: Optional[int] = None,
    limit: int = 100,
    userId: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Search facts using LIKE pattern matching on subject, predicate, or object."""
    ts = at if at is not None else int(time.time()*1000)
    search_pat = f"%{pattern}%"

    user_clause = "AND userId = ?" if userId else ""
    params: List[Any] = [ts, ts]
    if userId:
        params.append(userId)
    params.append(limit)

    where_clause = ""
    query_params = []

    if field in ["subject", "predicate", "object"]:
        where_clause = f"{field} LIKE ?"
        query_params = [search_pat]
    else:
        # "all" or invalid field -> search all columns
        where_clause = "(subject LIKE ? OR predicate LIKE ? OR object LIKE ?)"
        query_params = [search_pat, search_pat, search_pat]

    full_params = query_params + params

    t = q.tables
    sql = f"""
        SELECT id, userId, subject, predicate, object, validFrom, validTo, confidence, lastUpdated, metadata
        FROM {t['temporal_facts']}
        WHERE {where_clause}
        AND (validFrom <= ? AND (validTo IS NULL OR validTo >= ?))
        {user_clause}
        ORDER BY confidence DESC, validFrom DESC
        LIMIT ?
    """
    rows = await db.async_fetchall(sql, tuple(full_params))
    return [format_fact(r) for r in rows]


async def query_edges(
    sourceId: Optional[str] = None,
    targetId: Optional[str] = None,
    relationType: Optional[str] = None,
    at: Optional[int] = None,
    userId: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Query temporal edges with optional filters."""
    ts = at if at is not None else int(time.time()*1000)
    conds = ["(validFrom <= ? AND (validTo IS NULL OR validTo >= ?))"]
    params: List[Any] = [ts, ts]

    if sourceId:
        conds.append("sourceId = ?")
        params.append(sourceId)
    if targetId:
        conds.append("targetId = ?")
        params.append(targetId)
    if relationType:
        conds.append("relationType = ?")
        params.append(relationType)
    if userId:
        conds.append("userId = ?")
        params.append(userId)

    t = q.tables
    sql = f"""
        SELECT id, userId, sourceId, targetId, relationType, validFrom, validTo, weight, metadata
        FROM {t['temporal_edges']}
        WHERE {' AND '.join(conds)}
        ORDER BY weight DESC, validFrom DESC
    """
    rows = await db.async_fetchall(sql, tuple(params))
    return [
        {
            "id": r["id"],
            "userId": r["userId"],
            "sourceId": r["sourceId"],
            "targetId": r["targetId"],
            "relationType": r["relationType"],
            "validFrom": r["validFrom"],
            "validTo": r["validTo"],
            "weight": r["weight"],
            "metadata": json.loads(r["metadata"]) if r["metadata"] else None,
        }
        for r in rows
    ]


async def get_related_facts(
    fact_id: str,
    relationType: Optional[str] = None,
    at: Optional[int] = None,
    userId: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Perform a 1-hop traversal from a source fact.

    Returns:
        List of related facts and their relationship metadata.
    """
    ts = at if at is not None else int(time.time()*1000)

    sql_conds = [
        "e.sourceId = ?",
        "(e.validFrom <= ? AND (e.validTo IS NULL OR e.validTo >= ?))",
    ]
    params = [fact_id, ts, ts]

    if relationType:
        sql_conds.append("e.relationType = ?")
        params.append(relationType)

    # f validation
    sql_conds.append("(f.validFrom <= ? AND (f.validTo IS NULL OR f.validTo >= ?))")
    params.extend([ts, ts])

    if userId:
        sql_conds.append("e.userId = ?")
        params.append(userId)

    t = q.tables
    sql = f"""
        SELECT f.*, e.relationType, e.weight, e.userId as edge_userId
        FROM {t['temporal_edges']} e
        JOIN {t['temporal_facts']} f ON e.targetId = f.id
        WHERE {' AND '.join(sql_conds)}
        ORDER BY e.weight DESC, f.confidence DESC
    """

    rows = await db.async_fetchall(sql, tuple(params))
    return [
        {"fact": format_fact(r), "relation": r["relationType"], "weight": r["weight"]}
        for r in rows
    ]


def format_fact(row: Dict[str, Any]) -> Dict[str, Any]:
    """Helper to deserialize metadata and format a database row as a TemporalFact dict."""
    # Use camelCase names for the dict to match TypedDict
    return {
        "id": row["id"],
        "userId": row.get("userId"),
        "subject": row["subject"],
        "predicate": row["predicate"],
        "object": row["object"],
        "validFrom": row["validFrom"],
        "validTo": row["validTo"],
        "confidence": row["confidence"],
        "lastUpdated": row["lastUpdated"],
        "metadata": json.loads(row["metadata"]) if row["metadata"] else None,
    }
