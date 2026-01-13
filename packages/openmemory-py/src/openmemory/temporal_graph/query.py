import time
import json
from typing import List, Dict, Any, Optional

from ..core.db import db

# Port of backend/src/temporal_graph/query.ts


async def query_facts_at_time(
    subject: Optional[str] = None,
    predicate: Optional[str] = None,
    subject_object: Optional[str] = None,
    at: Optional[int] = None,
    min_confidence: float = 0.1,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Query facts that were active at a specific point in time.

    Args:
        subject: Optional subject filter.
        predicate: Optional predicate filter.
        subject_object: Optional object filter.
        at: Timestamp (ms). Default: now.
        min_confidence: Minimum confidence score.
        user_id: Owner user ID.

    Returns:
        List of matching TemporalFact dicts.
    """
    ts = at if at is not None else int(time.time()*1000)
    conds = ["(valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))"]
    params = [ts, ts]

    if subject:
        conds.append("subject = ?")
        params.append(subject)  # type: ignore[arg-type]
    if predicate:
        conds.append("predicate = ?")
        params.append(predicate)  # type: ignore[arg-type]
    if subject_object:
        conds.append("object = ?")
        params.append(subject_object)  # type: ignore[arg-type]
    if min_confidence > 0:
        conds.append("confidence >= ?")
        params.append(min_confidence)  # type: ignore[arg-type]
    if user_id:
        conds.append("user_id = ?")
        params.append(user_id)  # type: ignore[arg-type]

    sql = f"""
        SELECT id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE {' AND '.join(conds)}
        ORDER BY confidence DESC, valid_from DESC
    """
    rows = await db.async_fetchall(sql, tuple(params))
    return [format_fact(r) for r in rows]


async def get_current_fact(
    subject: str, predicate: str, user_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Get the currently active fact for a subject and predicate.

    Args:
        subject: The subject to query.
        predicate: The predicate to query.
        user_id: Owner user ID.

    Returns:
        The active TemporalFact or None.
    """
    user_clause = "AND user_id = ?" if user_id else ""
    params = (subject, predicate, user_id) if user_id else (subject, predicate)

    sql = f"""
        SELECT id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE subject = ? AND predicate = ? {user_clause} AND valid_to IS NULL
        ORDER BY valid_from DESC
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
    min_confidence: float = 0.1,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Query facts that were active at any point within a time range.

    Args:
        subject: Optional subject filter.
        predicate: Optional predicate filter.
        start: Start timestamp (ms).
        end: End timestamp (ms).
        min_confidence: Minimum confidence score.
        user_id: Owner user ID.

    Returns:
        List of matching TemporalFact dicts.
    """
    conds = []
    params = []

    if start is not None and end is not None:
        conds.append(
            "((valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)) OR (valid_from >= ? AND valid_from <= ?))"
        )
        params.extend([end, start, start, end])
    elif start is not None:
        conds.append("valid_from >= ?")
        params.append(start)
    elif end is not None:
        conds.append("valid_from <= ?")
        params.append(end)

    if subject:
        conds.append("subject = ?")
        params.append(subject)
    if predicate:
        conds.append("predicate = ?")
        params.append(predicate)
    if min_confidence > 0:
        conds.append("confidence >= ?")
        params.append(min_confidence)
    if user_id:
        conds.append("user_id = ?")
        params.append(user_id)

    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    sql = f"""
        SELECT id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        {where}
        ORDER BY valid_from DESC
    """
    rows = await db.async_fetchall(sql, tuple(params))
    return [format_fact(r) for r in rows]


async def find_conflicting_facts(
    subject: str,
    predicate: str,
    at: Optional[int] = None,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Find all facts for a (subject, predicate) that were active at a point in time.
    Used for detecting conflicting knowledge.
    """
    ts = at if at is not None else int(time.time()*1000)
    user_clause = "AND user_id = ?" if user_id else ""
    params = (
        (subject, predicate, ts, ts, user_id)
        if user_id
        else (subject, predicate, ts, ts)
    )

    sql = f"""
        SELECT id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE subject = ? AND predicate = ?
        AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        {user_clause}
        ORDER BY confidence DESC
    """
    rows = await db.async_fetchall(sql, params)
    return [format_fact(r) for r in rows]


async def get_facts_by_subject(
    subject: str,
    at: Optional[int] = None,
    include_historical: bool = False,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Get all facts relating to a specific subject entity."""
    user_clause = "AND user_id = ?" if user_id else ""
    params: List[Any] = [subject]
    if user_id:
        params.append(user_id)

    if include_historical:
        sql = f"""
            SELECT id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
            FROM temporal_facts
            WHERE subject = ? {user_clause}
            ORDER BY predicate ASC, valid_from DESC
        """
    else:
        ts = at if at is not None else int(time.time()*1000)
        sql = f"""
            SELECT id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
            FROM temporal_facts
            WHERE subject = ?
            AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
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
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Search facts using LIKE pattern matching on subject, predicate, or object."""
    ts = at if at is not None else int(time.time()*1000)
    search_pat = f"%{pattern}%"

    user_clause = "AND user_id = ?" if user_id else ""
    params: List[Any] = [ts, ts]
    if user_id:
        params.append(user_id)
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

    sql = f"""
        SELECT id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE {where_clause}
        AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        {user_clause}
        ORDER BY confidence DESC, valid_from DESC
        LIMIT ?
    """
    rows = await db.async_fetchall(sql, tuple(full_params))
    return [format_fact(r) for r in rows]


async def query_edges(
    source_id: Optional[str] = None,
    target_id: Optional[str] = None,
    relation_type: Optional[str] = None,
    at: Optional[int] = None,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Query temporal edges with optional filters."""
    ts = at if at is not None else int(time.time()*1000)
    conds = ["(valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))"]
    params: List[Any] = [ts, ts]

    if source_id:
        conds.append("source_id = ?")
        params.append(source_id)
    if target_id:
        conds.append("target_id = ?")
        params.append(target_id)
    if relation_type:
        conds.append("relation_type = ?")
        params.append(relation_type)
    if user_id:
        conds.append("user_id = ?")
        params.append(user_id)

    sql = f"""
        SELECT id, user_id, source_id, target_id, relation_type, valid_from, valid_to, weight, metadata
        FROM temporal_edges
        WHERE {' AND '.join(conds)}
        ORDER BY weight DESC, valid_from DESC
    """
    rows = await db.async_fetchall(sql, tuple(params))
    return [
        {
            "id": r["id"],
            "user_id": r["user_id"],
            "source_id": r["source_id"],
            "target_id": r["target_id"],
            "relation_type": r["relation_type"],
            "valid_from": r["valid_from"],
            "valid_to": r["valid_to"],
            "weight": r["weight"],
            "metadata": json.loads(r["metadata"]) if r["metadata"] else None,
        }
        for r in rows
    ]


async def get_related_facts(
    fact_id: str,
    relation_type: Optional[str] = None,
    at: Optional[int] = None,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Perform a 1-hop traversal from a source fact.

    Returns:
        List of related facts and their relationship metadata.
    """
    ts = at if at is not None else int(time.time()*1000)

    sql_conds = [
        "e.source_id = ?",
        "(e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?))",
    ]
    params = [fact_id, ts, ts]

    if relation_type:
        sql_conds.append("e.relation_type = ?")
        params.append(relation_type)

    # f validation
    sql_conds.append("(f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to >= ?))")
    params.extend([ts, ts])

    if user_id:
        sql_conds.append("e.user_id = ?")
        params.append(user_id)

    sql = f"""
        SELECT f.*, e.relation_type, e.weight, e.user_id as edge_user_id
        FROM temporal_edges e
        JOIN temporal_facts f ON e.target_id = f.id
        WHERE {' AND '.join(sql_conds)}
        ORDER BY e.weight DESC, f.confidence DESC
    """

    rows = await db.async_fetchall(sql, tuple(params))
    return [
        {"fact": format_fact(r), "relation": r["relation_type"], "weight": r["weight"]}
        for r in rows
    ]


def format_fact(row: Dict[str, Any]) -> Dict[str, Any]:
    """Helper to deserialize metadata and format a database row as a TemporalFact dict."""
    return {
        "id": row["id"],
        "user_id": row.get("user_id"),
        "subject": row["subject"],
        "predicate": row["predicate"],
        "object": row["object"],
        "valid_from": row["valid_from"],
        "valid_to": row["valid_to"],
        "confidence": row["confidence"],
        "last_updated": row["last_updated"],
        "metadata": json.loads(row["metadata"]) if row["metadata"] else None,
    }
