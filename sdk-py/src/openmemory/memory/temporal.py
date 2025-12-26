import time
import json
import uuid
from typing import List, Optional, Dict, Any, Union
from openmemory.core.db import q, many_query, exec_query

class TemporalFact(Dict[str, Any]):
    """
    Represents a temporal fact in the system.
    """
    id: str
    subject: str
    predicate: str
    object: str
    valid_from: int
    valid_to: Optional[int]
    confidence: float
    metadata: Dict[str, Any]

def _rid() -> str:
    return uuid.uuid4().hex

def _now() -> int:
    return int(time.time() * 1000)

def _j(obj: Any) -> str:
    return json.dumps(obj) if obj else "{}"

def create_fact(
    subject: str,
    predicate: str,
    object: str,
    valid_from: Optional[int] = None,
    valid_to: Optional[int] = None,
    confidence: float = 1.0,
    metadata: Optional[Dict[str, Any]] = None
) -> str:
    """
    Creates a new temporal fact.
    Enforces temporal integrity by invalidating existing open facts with the same subject and predicate
    that started before this new fact.

    Args:
        subject: The subject of the fact.
        predicate: The predicate of the fact.
        object: The object of the fact.
        valid_from: The timestamp (ms) when the fact becomes valid. Defaults to now.
        valid_to: The timestamp (ms) when the fact becomes invalid. Defaults to None (forever).
        confidence: The confidence score (0.0 - 1.0). Defaults to 1.0.
        metadata: Additional metadata for the fact.

    Returns:
        The ID of the created fact.
    """
    if valid_from is None:
        valid_from = _now()
    if metadata is None:
        metadata = {}

    if valid_to is not None and valid_to < valid_from:
        raise ValueError("valid_to cannot be less than valid_from")

    # 1. Integrity check: Invalidate overlapping open facts
    existing = many_query(
        "SELECT id, valid_from FROM temporal_facts WHERE subject = ? AND predicate = ? AND valid_to IS NULL ORDER BY valid_from DESC",
        (subject, predicate)
    )

    for old in existing:
        if old['valid_from'] < valid_from:
            close_time = valid_from - 1
            exec_query("UPDATE temporal_facts SET valid_to = ? WHERE id = ?", (close_time, old['id']))
        elif old['valid_from'] == valid_from:
            # Collision: existing fact starts at exact same time.
            # Bump the new fact's start time by 1ms to maintain strict ordering
            valid_from += 1
            close_time = valid_from - 1
            exec_query("UPDATE temporal_facts SET valid_to = ? WHERE id = ?", (close_time, old['id']))

    # 2. Insert new fact
    id = _rid()
    q.ins_fact.run(id, subject, predicate, object, valid_from, valid_to, confidence, _now(), _j(metadata))
    return id

def get_facts(
    filters: Optional[Dict[str, Union[str, int]]] = None
) -> List[TemporalFact]:
    """
    Retrieves facts based on filters.

    Args:
        filters: A dictionary containing filters:
            - subject: Filter by subject.
            - predicate: Filter by predicate.
            - object: Filter by object.
            - valid_at: Filter by a timestamp where the fact must be valid.

    Returns:
        A list of TemporalFact objects.
    """
    if filters is None:
        filters = {}

    rows = q.get_facts.all(filters)
    facts = []
    for r in rows:
        # Clone row to dict to avoid mutating row object if it's special
        fact = dict(r)
        if 'metadata' in fact and isinstance(fact['metadata'], str):
            try:
                fact['metadata'] = json.loads(fact['metadata'])
            except:
                fact['metadata'] = {}
        facts.append(fact) # type: ignore
    return facts # type: ignore

def invalidate_fact(id: str, valid_to: Optional[int] = None) -> None:
    """
    Invalidates a fact by setting its valid_to timestamp.

    Args:
        id: The ID of the fact to invalidate.
        valid_to: The timestamp (ms) when the fact becomes invalid. Defaults to now.
    """
    if valid_to is None:
        valid_to = _now()
    q.inv_fact.run(id, valid_to)

def create_edge(
    source_id: str,
    target_id: str,
    relation: str,
    weight: float = 1.0,
    metadata: Optional[Dict[str, Any]] = None
) -> str:
    """
    Creates a temporal edge between two facts.

    Args:
        source_id: The ID of the source fact.
        target_id: The ID of the target fact.
        relation: The type of relation.
        weight: The weight of the edge. Defaults to 1.0.
        metadata: Additional metadata.

    Returns:
        The ID of the created edge.
    """
    if metadata is None:
        metadata = {}

    id = _rid()
    # valid_from for edge defaults to now, valid_to defaults to null
    q.ins_edge.run(id, source_id, target_id, relation, _now(), None, weight, _j(metadata))
    return id

def get_edges(source_id: str) -> List[Dict[str, Any]]:
    """
    Retrieves all edges originating from a source fact.

    Args:
        source_id: The ID of the source fact.

    Returns:
        A list of edges.
    """
    rows = q.get_edges.all(source_id)
    edges = []
    for r in rows:
        edge = dict(r)
        if 'metadata' in edge and isinstance(edge['metadata'], str):
            try:
                edge['metadata'] = json.loads(edge['metadata'])
            except:
                edge['metadata'] = {}
        edges.append(edge)
    return edges

def get_related_facts(
    fact_id: str,
    relation_type: Optional[str] = None,
    at: Optional[int] = None
) -> List[Dict[str, Any]]:
    """
    Retrieves facts related to a given fact via edges.

    Args:
        fact_id: The ID of the fact to find relations for.
        relation_type: Optional relation type to filter by.
        at: Optional timestamp for validity check (default: now).

    Returns:
        List of dictionaries containing 'fact', 'relation', and 'weight'.
    """
    if at is None:
        at = _now()

    sql = """
        SELECT f.*, e.relation_type, e.weight
        FROM temporal_edges e
        JOIN temporal_facts f ON e.target_id = f.id
        WHERE e.source_id = ?
        AND (e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?))
        AND (f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to >= ?))
    """
    params = [fact_id, at, at, at, at]

    if relation_type:
        sql += " AND e.relation_type = ?"
        params.append(relation_type)

    sql += " ORDER BY e.weight DESC, f.confidence DESC"

    rows = many_query(sql, tuple(params))
    results = []
    for r in rows:
        r = dict(r)
        # Parse metadata
        meta = {}
        if r.get('metadata'):
            try: meta = json.loads(r['metadata'])
            except: pass

        fact = {
            'id': r['id'],
            'subject': r['subject'],
            'predicate': r['predicate'],
            'object': r['object'],
            'valid_from': r['valid_from'],
            'valid_to': r['valid_to'],
            'confidence': r['confidence'],
            'metadata': meta
        }
        results.append({
            'fact': fact,
            'relation': r['relation_type'],
            'weight': r['weight']
        })
    return results

def search_facts(
    pattern: str,
    field: str = 'subject',
    at: Optional[int] = None
) -> List[TemporalFact]:
    """
    Searches for facts matching a pattern.

    Args:
        pattern: The pattern to search for (substring).
        field: The field to search in ('subject', 'predicate', 'object').
        at: Optional timestamp for validity check (default: now).

    Returns:
        List of matching TemporalFact objects.
    """
    if at is None:
        at = _now()

    if field not in ['subject', 'predicate', 'object']:
        raise ValueError("Field must be one of 'subject', 'predicate', 'object'")

    search_pattern = f"%{pattern}%"
    sql = f"""
        SELECT id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM temporal_facts
        WHERE {field} LIKE ?
        AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        ORDER BY confidence DESC, valid_from DESC
        LIMIT 100
    """

    rows = many_query(sql, (search_pattern, at, at))
    facts = []
    for r in rows:
        fact = dict(r)
        if 'metadata' in fact and isinstance(fact['metadata'], str):
            try: fact['metadata'] = json.loads(fact['metadata'])
            except: fact['metadata'] = {}
        facts.append(fact) # type: ignore
    return facts # type: ignore

def get_subject_timeline(
    subject: str,
    predicate: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Retrieves the history of changes for a specific subject.

    Args:
        subject: The subject to analyze.
        predicate: Optional predicate filter.

    Returns:
        List of timeline entries sorted by timestamp.
    """
    sql = "SELECT subject, predicate, object, confidence, valid_from, valid_to FROM temporal_facts WHERE subject = ?"
    params = [subject]

    if predicate:
        sql += " AND predicate = ?"
        params.append(predicate)

    sql += " ORDER BY valid_from ASC"

    rows = many_query(sql, tuple(params))
    timeline = []

    for row in rows:
        timeline.append({
            'timestamp': row['valid_from'],
            'subject': row['subject'],
            'predicate': row['predicate'],
            'object': row['object'],
            'confidence': row['confidence'],
            'change_type': 'created'
        })

        if row['valid_to']:
            timeline.append({
                'timestamp': row['valid_to'],
                'subject': row['subject'],
                'predicate': row['predicate'],
                'object': row['object'],
                'confidence': row['confidence'],
                'change_type': 'invalidated'
            })

    return sorted(timeline, key=lambda x: x['timestamp'])

def get_changes_in_window(
    start: int,
    end: int,
    subject: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Retrieves changes within a specific time window.
    """
    sql = """
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM temporal_facts
        WHERE ((valid_from >= ? AND valid_from <= ?) OR (valid_to >= ? AND valid_to <= ?))
    """
    params = [start, end, start, end]

    if subject:
        sql += " AND subject = ?"
        params.append(subject)

    sql += " ORDER BY valid_from ASC"

    rows = many_query(sql, tuple(params))
    timeline = []

    for row in rows:
        if row['valid_from'] >= start and row['valid_from'] <= end:
            timeline.append({
                'timestamp': row['valid_from'],
                'subject': row['subject'],
                'predicate': row['predicate'],
                'object': row['object'],
                'confidence': row['confidence'],
                'change_type': 'created'
            })

        if row['valid_to'] and row['valid_to'] >= start and row['valid_to'] <= end:
            timeline.append({
                'timestamp': row['valid_to'],
                'subject': row['subject'],
                'predicate': row['predicate'],
                'object': row['object'],
                'confidence': row['confidence'],
                'change_type': 'invalidated'
            })

    return sorted(timeline, key=lambda x: x['timestamp'])

def get_change_frequency(
    subject: str,
    predicate: str,
    window_days: int = 30
) -> Dict[str, Any]:
    """
    Calculates the frequency of changes for a specific subject/predicate.
    """
    current_time = _now()
    window_start = current_time - (window_days * 86400000)

    sql = """
        SELECT valid_from, valid_to
        FROM temporal_facts
        WHERE subject = ? AND predicate = ?
        AND valid_from >= ?
        ORDER BY valid_from ASC
    """

    rows = many_query(sql, (subject, predicate, window_start))

    total_changes = len(rows)
    total_duration = 0
    valid_durations = 0

    for row in rows:
        if row['valid_to']:
            total_duration += row['valid_to'] - row['valid_from']
            valid_durations += 1

    avg_duration = total_duration / valid_durations if valid_durations > 0 else 0
    rate = total_changes / window_days

    return {
        'predicate': predicate,
        'total_changes': total_changes,
        'avg_duration_ms': avg_duration,
        'change_rate_per_day': rate
    }

def compare_time_points(
    subject: str,
    time1: int,
    time2: int
) -> Dict[str, List[Any]]:
    """
    Compares facts about a subject at two different time points.
    """
    facts_t1 = get_facts({'subject': subject, 'valid_at': time1})
    facts_t2 = get_facts({'subject': subject, 'valid_at': time2})

    map_t1 = {f['predicate']: f for f in facts_t1}
    map_t2 = {f['predicate']: f for f in facts_t2}

    added = []
    removed = []
    changed = []
    unchanged = []

    for pred, fact2 in map_t2.items():
        fact1 = map_t1.get(pred)
        if not fact1:
            added.append(fact2)
        elif fact1['object'] != fact2['object'] or fact1['id'] != fact2['id']:
            changed.append({'before': fact1, 'after': fact2})
        else:
            unchanged.append(fact2)

    for pred, fact1 in map_t1.items():
        if pred not in map_t2:
            removed.append(fact1)

    return {
        'added': added,
        'removed': removed,
        'changed': changed,
        'unchanged': unchanged
    }

def get_volatile_facts(
    subject: Optional[str] = None,
    limit: int = 10
) -> List[Dict[str, Any]]:
    """
    Identifies volatile facts that change frequently.
    """
    sql = """
        SELECT subject, predicate, COUNT(*) as change_count, AVG(confidence) as avg_confidence
        FROM temporal_facts
    """
    params = []

    if subject:
        sql += " WHERE subject = ?"
        params.append(subject)

    sql += """
        GROUP BY subject, predicate
        HAVING change_count > 1
        ORDER BY change_count DESC, avg_confidence ASC
        LIMIT ?
    """
    params.append(limit)

    return many_query(sql, tuple(params))
