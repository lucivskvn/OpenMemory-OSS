from typing import TypedDict, Optional, Any, Dict

# Port of backend/src/temporal_graph/types.ts

class TemporalFact(TypedDict):
    id: str
    userId: Optional[str]
    subject: str
    predicate: str
    object: str
    validFrom: int  # TS uses Date, we use ms timestamp
    validTo: Optional[int]
    confidence: float
    lastUpdated: int
    metadata: Optional[Dict[str, Any]]

class TemporalEdge(TypedDict):
    id: str
    userId: Optional[str]
    sourceId: str
    targetId: str
    relationType: str
    validFrom: int
    validTo: Optional[int]
    weight: float
    metadata: Optional[Dict[str, Any]]

class TimelineEntry(TypedDict):
    timestamp: int
    subject: str
    predicate: str
    object: str
    confidence: float
    change_type: str # 'created' | 'updated' | 'invalidated'

class TemporalQuery(TypedDict, total=False):
    userId: Optional[str]
    subject: Optional[str]
    predicate: Optional[str]
    object: Optional[str]
    at: Optional[int]
    start: Optional[int] # from
    end: Optional[int] # to
    minConfidence: Optional[float]
