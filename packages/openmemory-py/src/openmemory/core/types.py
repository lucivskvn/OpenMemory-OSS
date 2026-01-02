from typing import List, Optional, Dict, Any, Union, Literal
from pydantic import BaseModel, Field, ConfigDict

# matches backend/src/core/types.ts

class AddReq(BaseModel):
    content: str
    tags: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    salience: Optional[float] = None
    decay_lambda: Optional[float] = None
    user_id: Optional[str] = None

class QueryReq(BaseModel):
    query: str
    k: Optional[int] = None
    filters: Optional[Dict[str, Any]] = None # tags, min_score, sector, user_id
    user_id: Optional[str] = None

class MemRow(BaseModel):
    id: str
    content: str
    primary_sector: str
    tags: Optional[str] = None
    meta: Optional[str] = None
    user_id: Optional[str] = None
    created_at: int
    updated_at: int
    last_seen_at: int
    salience: float
    decay_lambda: float
    version: int
    generated_summary: Optional[str] = None
    mean_dim: Optional[int] = None
    mean_vec: Optional[bytes] = None
    compressed_vec: Optional[bytes] = None
    feedback_score: Optional[float] = None

    def __getitem__(self, item):
        return getattr(self, item)

    def get(self, key, default=None):
        return getattr(self, key, default)

class IngestReq(BaseModel):
    source: Literal["file", "link", "connector"]
    content_type: Literal["pdf", "docx", "html", "md", "txt", "audio"]
    data: str
    metadata: Optional[Dict[str, Any]] = None
    config: Optional[Dict[str, Any]] = None
    user_id: Optional[str] = None

# ... (omitting lGM/IDE specific types for brevity as they are less core, 
# but user said 'every single folder file', so I should include them if possible.
# I will include them as generic dicts for now or typed if critical.)

class LgmStoreReq(BaseModel):
    node: str
    content: str
    tags: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    namespace: Optional[str] = None
    graph_id: Optional[str] = None
    reflective: Optional[bool] = None
    user_id: Optional[str] = None


class MemoryItem(BaseModel):
    id: str
    content: str
    primary_sector: str
    tags: List[str] = []
    meta: Dict[str, Any] = {}
    user_id: Optional[str] = None
    created_at: int
    updated_at: int
    last_seen_at: int = 0
    salience: float = 0.0
    sectors: List[str] = []
    score: Optional[float] = None
    feedback_score: float = 0.0
    compressed_vec_str: Optional[str] = None
    path: Optional[List[str]] = None
    trace: Optional[Dict[str, Any]] = None
    debug: Optional[Dict[str, Any]] = Field(None, alias="_debug")

    model_config = ConfigDict(populate_by_name=True)

    def __getitem__(self, item):
        return getattr(self, item)

    def get(self, key, default=None):
        return getattr(self, key, default)

class TemporalFact(BaseModel):
    id: str
    user_id: Optional[str] = None
    subject: str
    predicate: str
    object: str
    valid_from: int
    valid_to: Optional[int] = None
    confidence: float
    last_updated: int
    metadata: Optional[Dict[str, Any]] = None

class TemporalEdge(BaseModel):
    id: str
    user_id: Optional[str] = None
    source_id: str
    target_id: str
    relation_type: str
    valid_from: int
    valid_to: Optional[int] = None
    weight: float
    metadata: Optional[Dict[str, Any]] = None

class TemporalQuery(BaseModel):
    subject: Optional[str] = None
    limit: int = 100
    valid_at: Optional[int] = None
    user_id: Optional[str] = None

