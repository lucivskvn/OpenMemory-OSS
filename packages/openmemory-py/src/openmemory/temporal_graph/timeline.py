import time
import json
from typing import List, Dict, Any, Optional

from ..core.db import db, q
from .query import query_facts_at_time, format_fact

# Port of backend/src/temporal_graph/timeline.ts


async def get_subject_timeline(
    subject: str, predicate: Optional[str] = None, userId: Optional[str] = None, user_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Get a chronological list of changes (creating/invalidated) for a subject.

    Args:
        subject: The subject entity to track.
        predicate: Optional predicate filter.
        userId: Owner user ID.

    Returns:
        Sorted list of TimelineEntry dicts.
    """
    userId = userId or user_id
    conds = ["subject = ?"]
    params: List[Any] = [subject]

    if userId:
        conds.append("user_id = ?")
        params.append(userId)
    else:
        conds.append("user_id IS NULL")

    if predicate:
        conds.append("predicate = ?")
        params.append(predicate)

    t = q.tables
    sql = f"""
        SELECT subject, predicate, object, confidence, valid_from as validFrom, valid_to as validTo
        FROM {t['temporal_facts']}
        WHERE {' AND '.join(conds)}
        ORDER BY validFrom ASC
    """
    rows = await db.async_fetchall(sql, tuple(params))
    return _build_timeline(rows)


def _build_timeline(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Helper to convert rows into event-based timeline entries."""
    timeline = []
    for row in rows:
        timeline.append(
            {
                "timestamp": row["validFrom"],
                "subject": row["subject"],
                "predicate": row["predicate"],
                "object": row["object"],
                "confidence": row["confidence"],
                "change_type": "created",
            }
        )
        if row["validTo"]:
            timeline.append(
                {
                    "timestamp": row["validTo"],
                    "subject": row["subject"],
                    "predicate": row["predicate"],
                    "object": row["object"],
                    "confidence": row["confidence"],
                    "change_type": "invalidated",
                }
            )
    timeline.sort(key=lambda x: x["timestamp"])
    return timeline


async def get_predicate_timeline(
    predicate: str,
    start: Optional[int] = None,
    end: Optional[int] = None,
    userId: Optional[str] = None,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Get a timeline of all facts using a specific predicate."""
    userId = userId or user_id
    conds = ["predicate = ?"]
    params: List[Any] = [predicate]

    if userId:
        conds.append("user_id = ?")
        params.append(userId)
    else:
        conds.append("user_id IS NULL")

    if start is not None:
        conds.append("validFrom >= ?")
        params.append(start)
    if end is not None:
        conds.append("validFrom <= ?")
        params.append(end)

    t = q.tables
    sql = f"""
        SELECT subject, predicate, object, confidence, valid_from as validFrom, valid_to as validTo
        FROM {t['temporal_facts']}
        WHERE {' AND '.join(conds)}
        ORDER BY validFrom ASC
    """
    rows = await db.async_fetchall(sql, tuple(params))
    return _build_timeline(rows)


async def get_changes_in_window(
    start: int, end: int, subject: Optional[str] = None, userId: Optional[str] = None, user_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Get all temporal changes that occurred within a specific time window."""
    userId = userId or user_id
    conds = []
    params: List[Any] = [start, end, start, end]  # from_ts, to_ts, from_ts, to_ts

    if subject:
        conds.append("subject = ?")
        params.append(subject)
    if userId:
        conds.append("user_id = ?")
        params.append(userId)

    where_sub = f"AND {' AND '.join(conds)}" if conds else ""

    t = q.tables
    sql = f"""
        SELECT subject, predicate, object, confidence, valid_from as validFrom, valid_to as validTo
        FROM {t['temporal_facts']}
        WHERE ((valid_from >= ? AND valid_from <= ?) OR (valid_to >= ? AND valid_to <= ?))
        {where_sub}
    """
    rows = await db.async_fetchall(sql, tuple(params))
    timeline = []

    for row in rows:
        if row["validFrom"] >= start and row["validFrom"] <= end:
            timeline.append(
                {
                    "timestamp": row["validFrom"],
                    "subject": row["subject"],
                    "predicate": row["predicate"],
                    "object": row["object"],
                    "confidence": row["confidence"],
                    "change_type": "created",
                }
            )
        if row["validTo"] and row["validTo"] >= start and row["validTo"] <= end:
            timeline.append(
                {
                    "timestamp": row["validTo"],
                    "subject": row["subject"],
                    "predicate": row["predicate"],
                    "object": row["object"],
                    "confidence": row["confidence"],
                    "change_type": "invalidated",
                }
            )

    timeline.sort(key=lambda x: x["timestamp"])
    return timeline


async def compare_time_points(
    subject: str, t1: int, t2: int, userId: Optional[str] = None, user_id: Optional[str] = None
) -> Dict[str, List[Dict[str, Any]]]:
    """Compare the state of a subject at two different points in time."""
    userId = userId or user_id
    user_clause = "AND user_id = ?" if userId else "AND user_id IS NULL"
    user_param = (userId,) if userId else ()  # type: ignore[assignment]

    t = q.tables
    sql1 = f"""
        SELECT id, user_id, subject, predicate, object, valid_from as validFrom, valid_to as validTo, confidence, last_updated, metadata
        FROM {t['temporal_facts']}
        WHERE subject = ?
        AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
        {user_clause}
    """
    f1 = await db.async_fetchall(sql1, (subject, t1, t1) + user_param)  # type: ignore[arg-type]
    f2 = await db.async_fetchall(sql1, (subject, t2, t2) + user_param)  # type: ignore[arg-type]

    m1 = {r["predicate"]: r for r in f1}
    m2 = {r["predicate"]: r for r in f2}

    added = []
    removed = []
    changed = []
    unchanged = []

    for pred, fact2 in m2.items():
        fact1 = m1.get(pred)
        if not fact1:
            added.append(format_fact(fact2))
        elif fact1["object"] != fact2["object"] or fact1["id"] != fact2["id"]:
            changed.append({
                "before": format_fact(fact1),
                "after": format_fact(fact2)
            })
        else:
            unchanged.append(format_fact(fact2))

    for pred, fact1 in m1.items():
        if pred not in m2:
            removed.append(format_fact(fact1))

    return {"added": added, "removed": removed, "changed": changed, "unchanged": unchanged}


async def get_change_frequency(
    subject: str, predicate: str, window_days: int = 30, userId: Optional[str] = None, user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Calculate the frequency of changes for a specific subject-predicate pair."""
    userId = userId or user_id
    now = int(time.time()*1000)
    start = now - (window_days * 86400000)

    user_clause = "AND user_id = ?" if userId else ""
    user_param = (userId,) if userId else ()

    t = q.tables
    sql = f"""
        SELECT valid_from as validFrom, valid_to as validTo
        FROM {t['temporal_facts']}
        WHERE subject = ? AND predicate = ?
        AND valid_from >= ?
        {user_clause}
        ORDER BY validFrom ASC
    """
    rows = await db.async_fetchall(sql, (subject, predicate, start) + user_param)

    total_changes = len(rows)
    total_dur = 0
    valid_count = 0

    for r in rows:
        if r["validTo"]:
            total_dur += r["validTo"] - r["validFrom"]
            valid_count += 1

    avg_dur = total_dur / valid_count if valid_count > 0 else 0
    rate = total_changes / window_days

    return {
        "predicate": predicate,
        "total_changes": total_changes,
        "avg_duration_ms": avg_dur,
        "change_rate_per_day": rate
    }


async def get_volatile_facts(
    subject: Optional[str] = None, limit: int = 10, userId: Optional[str] = None, user_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Identify facts that change frequently (volatility analysis)."""
    userId = userId or user_id
    conds = []
    params = []
    if subject:
        conds.append("subject = ?")
        params.append(subject)
    if userId:
        conds.append("user_id = ?")
        params.append(userId)

    where = f"WHERE {' AND '.join(conds)}" if conds else ""

    t = q.tables
    sql = f"""
        SELECT subject, predicate, COUNT(*) as change_count, AVG(confidence) as avg_confidence
        FROM {t['temporal_facts']}
        {where}
        GROUP BY subject, predicate
        HAVING change_count > 1
        ORDER BY change_count DESC, avg_confidence ASC
        LIMIT ?
    """
    rows = await db.async_fetchall(sql, tuple(params + [limit]))
    return rows
