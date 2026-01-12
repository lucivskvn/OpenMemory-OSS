from typing import List, Optional, Dict, Any, Union, Literal
from pydantic import BaseModel, Field, ConfigDict
from .constants import COGNITIVE_PARAMS

# matches backend/src/core/types.ts

class AddRequest(BaseModel):
    content: str
    tags: List[str] = []
    metadata: Dict[str, Any] = {}
    userId: Optional[str] = None
    id: Optional[str] = None
    createdAt: Optional[int] = None

    model_config = ConfigDict(populate_by_name=True)

class BatchAddRequest(BaseModel):
    items: List[AddRequest]
    userId: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)

class QueryRequest(BaseModel):
    query: str
    limit: int = 10
    userId: Optional[str] = None
    filters: Dict[str, Any] = {}

    model_config = ConfigDict(populate_by_name=True)

class ReinforceRequest(BaseModel):
    id: str
    boost: float = 0.1
    userId: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)

class MemRow(BaseModel):
    id: str
    content: str
    primarySector: str
    tags: Optional[str] = None
    meta: Optional[str] = None
    userId: Optional[str] = None
    createdAt: int
    updatedAt: int
    lastSeenAt: int = COGNITIVE_PARAMS["DEFAULT_LAST_SEEN_AT"]
    salience: float = COGNITIVE_PARAMS["DEFAULT_SALIENCE"]
    decayLambda: float = COGNITIVE_PARAMS["DEFAULT_DECAY_LAMBDA"]
    version: int = COGNITIVE_PARAMS["DEFAULT_VERSION"]
    segment: int = COGNITIVE_PARAMS["DEFAULT_SEGMENT"]
    simhash: Optional[str] = None
    generatedSummary: Optional[str] = None
    meanDim: Optional[int] = None
    meanVec: Optional[bytes] = None
    compressedVec: Optional[bytes] = None
    feedbackScore: Optional[float] = None

    model_config = ConfigDict(populate_by_name=True)

    def __getitem__(self, item):
        return getattr(self, item)

    def get(self, key, default=None):
        return getattr(self, key, default)

class IngestRequest(BaseModel):
    source: Optional[Literal["file", "link", "connector"]] = None
    contentType: str = "text"
    data: str
    metadata: Dict[str, Any] = {}
    config: Dict[str, Any] = {}
    userId: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)

# ... (omitting lGM/IDE specific types for brevity as they are less core,
# but user said 'every single folder file', so I should include them if possible.
# I will include them as generic dicts for now or typed if critical.)

class LgmStoreReq(BaseModel):
    node: str
    content: str
    tags: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    namespace: Optional[str] = None
    graphId: Optional[str] = None
    reflective: Optional[bool] = None
    userId: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)


class MemoryItem(BaseModel):
    id: str
    content: str
    primarySector: str
    tags: List[str] = []
    meta: Dict[str, Any] = {}
    userId: Optional[str] = None
    createdAt: int
    updatedAt: int
    lastSeenAt: int = COGNITIVE_PARAMS["DEFAULT_LAST_SEEN_AT"]
    salience: float = COGNITIVE_PARAMS["DEFAULT_SALIENCE"]
    decayLambda: float = COGNITIVE_PARAMS["DEFAULT_DECAY_LAMBDA"]
    version: int = COGNITIVE_PARAMS["DEFAULT_VERSION"]
    segment: int = COGNITIVE_PARAMS["DEFAULT_SEGMENT"]
    simhash: Optional[str] = None
    generatedSummary: Optional[str] = None
    sectors: List[str] = []
    score: Optional[float] = None
    path: Optional[List[str]] = None
    trace: Optional[Dict[str, Any]] = None
    feedbackScore: Optional[float] = None

    model_config = ConfigDict(populate_by_name=True)

class GraphMemoryItem(MemoryItem):
    node: str
    compressedVecStr: Optional[str] = None
    debug: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(populate_by_name=True)

    def __getitem__(self, item):
        return getattr(self, item)

    def get(self, key, default=None):
        return getattr(self, key, default)

class TemporalFact(BaseModel):
    id: str
    userId: Optional[str] = None
    subject: str
    predicate: str
    object: str
    validFrom: int
    validTo: Optional[int] = None
    confidence: float
    sourceId: Optional[str] = None
    lastUpdated: int
    metadata: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(populate_by_name=True)

class TemporalEdge(BaseModel):
    id: str
    userId: Optional[str] = None
    sourceId: str
    targetId: str
    relationType: str
    validFrom: int
    validTo: Optional[int] = None
    weight: float
    metadata: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(populate_by_name=True)

class TemporalQuery(BaseModel):
    userId: Optional[str] = None
    subject: Optional[str] = None
    predicate: Optional[str] = None
    object: Optional[str] = None
    at: Optional[Union[int, float]] = None
    from_: Optional[Union[int, float]] = None
    to: Optional[Union[int, float]] = None
    minConfidence: Optional[float] = None
    limit: int = 100

    model_config = ConfigDict(populate_by_name=True)

class LgmRetrieveReq(BaseModel):
    node: str
    query: Optional[str] = None
    namespace: Optional[str] = None
    graph_id: Optional[str] = None
    limit: Optional[int] = None
    include_metadata: Optional[bool] = None
    user_id: Optional[str] = None

class LgmContextReq(BaseModel):
    node: Optional[str] = None
    graph_id: Optional[str] = None
    namespace: Optional[str] = None
    user_id: Optional[str] = None
    limit: Optional[int] = None

class LgmReflectionReq(BaseModel):
    graph_id: str
    node: str
    content: str
    context_ids: Optional[List[str]] = None
    namespace: Optional[str] = None
    user_id: Optional[str] = None


# --- Ingestion Types (Parity with JS SDK) ---

class IngestionConfig(BaseModel):
    """Configuration for document and URL ingestion."""
    force_root: Optional[bool] = Field(None, alias="forceRoot")
    sec_sz: Optional[int] = Field(None, alias="secSz")
    lg_thresh: Optional[int] = Field(None, alias="lgThresh")
    fast_summarize: Optional[bool] = Field(None, alias="fastSummarize")

    model_config = ConfigDict(populate_by_name=True)


class IngestionResult(BaseModel):
    """Result of the ingestion process."""
    root_memory_id: str = Field(..., alias="rootMemoryId")
    child_count: int = Field(..., alias="childCount")
    total_tokens: int = Field(..., alias="totalTokens")
    strategy: Literal["single", "root-child"]
    extraction: Dict[str, Any] = {}

    model_config = ConfigDict(populate_by_name=True)


# --- IDE Request Types ---

class IdeEventRequestMetadata(BaseModel):
    lang: Optional[str] = None
    model_config = ConfigDict(extra='allow')

class IdeEventRequest(BaseModel):
    session_id: str = Field(..., alias="sessionId")
    event: str = Field(..., alias="eventType")
    file: Optional[str] = Field(None, alias="filePath")
    snippet: Optional[str] = Field(None, alias="content")
    comment: Optional[str] = None
    metadata: IdeEventRequestMetadata = Field(default_factory=IdeEventRequestMetadata)
    user_id: Optional[str] = Field(None, alias="userId")

    model_config = ConfigDict(populate_by_name=True)

class IdeContextRequest(BaseModel):
    query: str
    limit: int = 5
    session_id: Optional[str] = Field(None, alias="sessionId")
    file_path: Optional[str] = Field(None, alias="filePath")
    user_id: Optional[str] = Field(None, alias="userId")

    model_config = ConfigDict(populate_by_name=True)

# --- IDE Integration Types (Parity with JS SDK) ---

class IdeContextItem(BaseModel):
    """Context item for IDE integration."""
    memory_id: str = Field(..., alias="memoryId")
    content: str
    primary_sector: str = Field(..., alias="primarySector")
    sectors: List[str] = []
    score: float
    salience: float
    last_seen_at: int = Field(..., alias="lastSeenAt")
    path: List[str] = []

    model_config = ConfigDict(populate_by_name=True)


class IdeContextResult(BaseModel):
    """Result of IDE context retrieval."""
    success: bool
    context: List[IdeContextItem] = []
    query: str

    model_config = ConfigDict(populate_by_name=True)


class IdePattern(BaseModel):
    """Detected coding pattern from IDE events."""
    pattern_id: str = Field(..., alias="patternId")
    description: str
    salience: float
    detected_at: int = Field(..., alias="detectedAt")
    last_reinforced: int = Field(..., alias="lastReinforced")
    confidence: Optional[float] = None
    affected_files: Optional[List[str]] = Field(None, alias="affectedFiles")

    model_config = ConfigDict(populate_by_name=True)


class IdePatternsResult(BaseModel):
    """Result of pattern retrieval."""
    success: bool
    session_id: str = Field(..., alias="sessionId")
    pattern_count: int = Field(..., alias="patternCount")
    patterns: List[IdePattern] = []

    model_config = ConfigDict(populate_by_name=True)


# --- Compression Types (Parity with JS SDK) ---

class CompressionMetrics(BaseModel):
    """Metrics from vector compression."""
    original_tokens: int = Field(..., alias="originalTokens")
    compressed_tokens: int = Field(..., alias="compressedTokens")
    ratio: float
    saved: int
    pct: float
    latency: float
    algorithm: str
    timestamp: int

    model_config = ConfigDict(populate_by_name=True)


class CompressionResult(BaseModel):
    """Result of compression operation."""
    og: str
    comp: str
    metrics: CompressionMetrics
    hash: str

    model_config = ConfigDict(populate_by_name=True)


class CompressionStats(BaseModel):
    """Aggregate compression statistics."""
    total: int
    original_tokens: int = Field(..., alias="originalTokens")
    compressed_tokens: int = Field(..., alias="compressedTokens")
    saved: int
    avg_ratio: float = Field(..., alias="avgRatio")
    latency: float
    algorithms: Dict[str, int]
    updated: int

    model_config = ConfigDict(populate_by_name=True)


# --- LangGraph Result Types (Parity with JS SDK) ---

class LgStoreResult(BaseModel):
    """Result of LangGraph store operation."""
    success: bool
    memory_id: str = Field(..., alias="memoryId")
    node: str
    memory: Optional[MemoryItem] = None

    model_config = ConfigDict(populate_by_name=True)


class LgRetrieveResult(BaseModel):
    """Result of LangGraph retrieve operation."""
    success: bool
    memories: List[MemoryItem] = []

    model_config = ConfigDict(populate_by_name=True)


class LgNodeContext(BaseModel):
    """Context item for a specific LangGraph node."""
    node: str
    items: List[MemoryItem] = []

    model_config = ConfigDict(populate_by_name=True)


class LgContextResult(BaseModel):
    """Result of LangGraph context operation."""
    success: bool
    context: str
    sources: List[str] = []
    nodes: Optional[List[LgNodeContext]] = None

    model_config = ConfigDict(populate_by_name=True)


class LgReflectResult(BaseModel):
    """Result of LangGraph reflection operation."""
    success: bool
    reflection_id: str = Field(..., alias="reflectionId")
    insights: List[str] = []

    model_config = ConfigDict(populate_by_name=True)


# --- Dashboard/Stats Types (Parity with JS SDK) ---

class SectorStat(BaseModel):
    sector: str
    count: int
    avg_salience: float = Field(..., alias="avgSalience")

    model_config = ConfigDict(populate_by_name=True)

class DecayStats(BaseModel):
    total: int
    avg_lambda: str = Field(..., alias="avgLambda")
    min_salience: str = Field(..., alias="minSalience")
    max_salience: str = Field(..., alias="maxSalience")

    model_config = ConfigDict(populate_by_name=True)

class RequestStats(BaseModel):
    total: int
    errors: int
    error_rate: str = Field(..., alias="errorRate")
    last_hour: int = Field(..., alias="lastHour")

    model_config = ConfigDict(populate_by_name=True)

class QpsStats(BaseModel):
    peak: float
    average: float
    cache_hit_rate: float = Field(..., alias="cacheHitRate")

    model_config = ConfigDict(populate_by_name=True)

class SystemResourceStats(BaseModel):
    memory_usage: int = Field(..., alias="memoryUsage")
    heap_used: int = Field(..., alias="heapUsed")
    heap_total: int = Field(..., alias="heapTotal")
    uptime: Dict[str, int]

    model_config = ConfigDict(populate_by_name=True)

class ConfigStats(BaseModel):
    port: int
    vec_dim: int = Field(..., alias="vecDim")
    cache_segments: int = Field(..., alias="cacheSegments")
    max_active: int = Field(..., alias="maxActive")
    decay_interval: int = Field(..., alias="decayInterval")
    embed_provider: str = Field(..., alias="embedProvider")

    model_config = ConfigDict(populate_by_name=True)

class SystemStats(BaseModel):
    total_memories: int = Field(..., alias="totalMemories")
    recent_memories: int = Field(..., alias="recentMemories")
    sector_counts: Dict[str, int] = Field(..., alias="sectorCounts")
    avg_salience: str = Field(..., alias="avgSalience")
    decay_stats: DecayStats = Field(..., alias="decayStats")
    requests: RequestStats
    qps: QpsStats
    system: SystemResourceStats
    config: ConfigStats

    model_config = ConfigDict(populate_by_name=True)

class MaintenanceOperationStat(BaseModel):
    hour: str
    decay: int
    reflection: int
    consolidation: int

class MaintenanceTotals(BaseModel):
    cycles: int
    reflections: int
    consolidations: int

class MaintenanceStats(BaseModel):
    operations: List[MaintenanceOperationStat]
    totals: MaintenanceTotals

    model_config = ConfigDict(populate_by_name=True)

# --- Dynamics/Graph Result Types (Parity with JS SDK) ---

class ResonanceResult(BaseModel):
    success: bool
    resonance_modulated_score: float = Field(..., alias="resonanceModulatedScore")
    parameters: Dict[str, Any]

    model_config = ConfigDict(populate_by_name=True)

class RetrievalResult(BaseModel):
    success: bool
    query: str
    sector: str
    min_energy: float = Field(..., alias="minEnergy")
    count: int
    memories: List[Dict[str, Any]]

    model_config = ConfigDict(populate_by_name=True)

class ReinforcementResult(BaseModel):
    success: bool
    propagated_count: int = Field(..., alias="propagatedCount")
    new_salience: float = Field(..., alias="newSalience")

    model_config = ConfigDict(populate_by_name=True)

class ActivationResultItem(BaseModel):
    memory_id: str = Field(..., alias="memoryId")
    activation_level: float = Field(..., alias="activationLevel")

    model_config = ConfigDict(populate_by_name=True)

class SpreadingActivationResult(BaseModel):
    success: bool
    initial_count: int = Field(..., alias="initialCount")
    iterations: int
    total_activated: int = Field(..., alias="totalActivated")
    results: List[ActivationResultItem]

    model_config = ConfigDict(populate_by_name=True)

class WaypointWeightResult(BaseModel):
    success: bool
    source_id: str = Field(..., alias="sourceId")
    target_id: str = Field(..., alias="targetId")
    weight: float
    time_gap_days: float = Field(..., alias="timeGapDays")
    details: Dict[str, bool]

    model_config = ConfigDict(populate_by_name=True)

class SalienceResult(BaseModel):
    success: bool
    calculated_salience: float = Field(..., alias="calculatedSalience")
    parameters: Dict[str, Any]

    model_config = ConfigDict(populate_by_name=True)

class TopMemory(BaseModel):
    id: str
    content: str
    sector: str
    salience: float
    last_seen: int = Field(..., alias="lastSeen")

    model_config = ConfigDict(populate_by_name=True)

class ActivityItem(BaseModel):
    id: str
    type: str # 'memory' or 'event'
    sector: str
    content: str
    salience: float
    timestamp: int

    model_config = ConfigDict(populate_by_name=True)
