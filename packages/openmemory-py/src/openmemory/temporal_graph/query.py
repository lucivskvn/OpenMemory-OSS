import time
import os
import asyncio

def enforce_tenant(user_id: str = None) -> str:
    if user_id:
        return user_id
    if os.environ.get("OM_ALLOW_ANONYMOUS_TENANT") == "true":
        return "anonymous"
    raise ValueError("MissingTenantError: user_id is required for multi-tenant isolation.")

import json
from typing import List, Dict, Any, Optional

from ..core.db import db

async def query_facts_at_time(subject: Optional[str] = None, predicate: Optional[str] = None, subject_object: Optional[str] = None, at: int = None, min_confidence: float = 0.1, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
    user_id = enforce_tenant(user_id)
    ts = at if at is not None else int(time.time()*1000)
    conds = ["user_id = ?", "(valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))"]
    params = [user_id, ts, ts]
    if subject:
        conds.append("subject = ?")
        params.append(subject)
    if predicate:
        conds.append("predicate = ?")
        params.append(predicate)
    if subject_object:
        conds.append("object = ?")
        params.append(subject_object)
    if min_confidence > 0:
        conds.append("confidence >= ?")
        params.append(min_confidence)

    sql = f"""
        SELECT id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE {' AND '.join(conds)}
        ORDER BY confidence DESC, valid_from DESC
    """
    rows = await asyncio.to_thread(db.fetchall, sql, tuple(params))
    return [format_fact(r) for r in rows]

async def get_current_fact(subject: str, predicate: str, user_id: str = None) -> Optional[Dict[str, Any]]:
    user_id = enforce_tenant(user_id)
    sql = """
        SELECT id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE subject = ? AND predicate = ? AND user_id = ? AND valid_to IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
    """
    row = await asyncio.to_thread(db.fetchone, sql, (subject, predicate, user_id))
    if not row:
        return None
    return format_fact(row)

async def query_facts_in_range(subject: str = None, predicate: str = None, start: int = None, end: int = None, min_confidence: float = 0.1, user_id: str = None) -> List[Dict[str, Any]]:
    user_id = enforce_tenant(user_id)
    conds = ["user_id = ?"]
    params = [user_id]

    if start is not None and end is not None:
        conds.append("((valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)) OR (valid_from >= ? AND valid_from <= ?))")
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

    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    sql = f"""
        SELECT id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        {where}
        ORDER BY valid_from DESC
    """
    rows = await asyncio.to_thread(db.fetchall, sql, tuple(params))
    return [format_fact(r) for r in rows]

async def find_conflicting_facts(subject: str, predicate: str, at: int = None, user_id: str = None) -> List[Dict[str, Any]]:
    user_id = enforce_tenant(user_id)
    ts = at if at is not None else int(time.time()*1000)
    sql = """
        SELECT id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE subject = ? AND user_id = ? AND predicate = ? AND user_id = ?
        AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        ORDER BY confidence DESC
    """
    rows = await asyncio.to_thread(db.fetchall, sql, (subject, predicate, user_id, ts, ts))
    return [format_fact(r) for r in rows]

async def get_facts_by_subject(subject: str, at: int = None, include_historical: bool = False, user_id: str = None) -> List[Dict[str, Any]]:
    user_id = enforce_tenant(user_id)
    params = [subject, user_id]
    if include_historical:
        sql = """
            SELECT id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
            FROM temporal_facts
            WHERE subject = ? AND user_id = ?
            ORDER BY predicate ASC, valid_from DESC
        """
    else:
        ts = at if at is not None else int(time.time()*1000)
        sql = """
            SELECT id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
            FROM temporal_facts
            WHERE subject = ? AND user_id = ?
            AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
            ORDER BY predicate ASC, confidence DESC
        """
        params.extend([ts, ts])

    rows = await asyncio.to_thread(db.fetchall, sql, tuple(params))
    return [format_fact(r) for r in rows]

async def search_facts(pattern: str, field: str = "subject", at: int = None, user_id: str = None) -> List[Dict[str, Any]]:
    user_id = enforce_tenant(user_id)
    ts = at if at is not None else int(time.time()*1000)
    search_pat = f"%{pattern}%"
    if field not in ["subject", "predicate", "object"]: field = "subject"

    sql = f"""
        SELECT id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE {field} LIKE ? AND user_id = ?
        AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        ORDER BY confidence DESC, valid_from DESC
        LIMIT 100
    """
    rows = await asyncio.to_thread(db.fetchall, sql, (search_pat, user_id, ts, ts))
    return [format_fact(r) for r in rows]

async def get_related_facts(fact_id: str, relation_type: str = None, at: int = None, user_id: str = None) -> List[Dict[str, Any]]:
    user_id = enforce_tenant(user_id)
    ts = at if at is not None else int(time.time()*1000)
    conds = ["e.user_id = ?", "f.user_id = ?", "(e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?))"]
    params = [user_id, user_id, ts, ts]

    if relation_type:
        conds.append("e.relation_type = ?")
        params.append(relation_type)

    sql = f"""
        SELECT f.*, e.relation_type, e.weight
        FROM temporal_edges e
        JOIN temporal_facts f ON e.target_id = f.id
        WHERE e.source_id = ?
        AND {' AND '.join(conds)}
        AND (f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to >= ?))
        ORDER BY e.weight DESC, f.confidence DESC
    """
    params.insert(0, fact_id)
    params.extend([ts, ts])

    rows = await asyncio.to_thread(db.fetchall, sql, tuple(params))
    return [{
        "fact": format_fact(r),
        "relation": r["relation_type"],
        "weight": r["weight"]
    } for r in rows]

def format_fact(row: Dict[str, Any]) -> Dict[str, Any]:
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
        "metadata": json.loads(row["metadata"]) if row["metadata"] else None
    }
