"""
Audited: 2026-01-19
Pydantic models and type definitions for OpenMemory SDK.
"""
from typing import List, Optional, Dict, Any, Union, Literal
from pydantic import BaseModel, Field, ConfigDict
from .constants import COGNITIVE_PARAMS

# matches backend/src/core/types.ts

class AddRequest(BaseModel):
    content: str
    tags: List[str] = []
    metadata: Dict[str, Any] = {}
    userId: Optional[str] = Field(None, alias="user_id")
    id: Optional[str] = None
    createdAt: Optional[int] = Field(None, alias="created_at")

    model_config = ConfigDict(populate_by_name=True)

class BatchAddRequest(BaseModel):
    items: List[AddRequest]
    userId: Optional[str] = Field(None, alias="user_id")

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
    primarySector: str = Field(..., alias="primary_sector")
    tags: Optional[str] = None
    metadata: Optional[str] = None
    userId: Optional[str] = Field(None, alias="user_id")
    createdAt: int = Field(..., alias="created_at")
    updatedAt: int = Field(..., alias="updated_at")
    lastSeenAt: int = Field(COGNITIVE_PARAMS["DEFAULT_LAST_SEEN_AT"], alias="last_seen_at")
    salience: float = COGNITIVE_PARAMS["DEFAULT_SALIENCE"]
    decayLambda: float = Field(COGNITIVE_PARAMS["DEFAULT_DECAY_LAMBDA"], alias="decay_lambda")
    version: int = COGNITIVE_PARAMS["DEFAULT_VERSION"]
    segment: int = COGNITIVE_PARAMS["DEFAULT_SEGMENT"]
    simhash: Optional[str] = None
    generatedSummary: Optional[str] = Field(None, alias="generated_summary")
    meanDim: Optional[int] = Field(None, alias="mean_dim")
    meanVec: Optional[bytes] = Field(None, alias="mean_vec")
    compressedVec: Optional[bytes] = Field(None, alias="compressed_vec")
    feedbackScore: Optional[float] = Field(None, alias="feedback_score")

    model_config = ConfigDict(populate_by_name=True)

    def __getitem__(self, item):
        try:
            return getattr(self, item)
        except AttributeError:
            if item == "feedback_score": return self.feedbackScore
            raise

    def get(self, key, default=None):
        try:
            return getattr(self, key)
        except AttributeError:
            if key == "feedback_score": return self.feedbackScore
            return default

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
    graphId: Optional[str] = Field(None, alias="graph_id")
    reflective: Optional[bool] = None
    userId: Optional[str] = Field(None, alias="user_id")

    model_config = ConfigDict(populate_by_name=True)


class MemoryItem(BaseModel):
    id: str
    content: str
    primarySector: str = Field(..., alias="primary_sector")
    tags: List[str] = []
    metadata: Dict[str, Any] = {}
    userId: Optional[str] = Field(None, alias="user_id")
    createdAt: int = Field(..., alias="created_at")
    updatedAt: int = Field(..., alias="updated_at")
    lastSeenAt: int = Field(COGNITIVE_PARAMS["DEFAULT_LAST_SEEN_AT"], alias="last_seen_at")
    salience: float = COGNITIVE_PARAMS["DEFAULT_SALIENCE"]
    decayLambda: float = Field(COGNITIVE_PARAMS["DEFAULT_DECAY_LAMBDA"], alias="decay_lambda")
    version: int = COGNITIVE_PARAMS["DEFAULT_VERSION"]
    segment: int = COGNITIVE_PARAMS["DEFAULT_SEGMENT"]
    simhash: Optional[str] = None
    generatedSummary: Optional[str] = Field(None, alias="generated_summary")
    sectors: List[str] = []
    score: Optional[float] = None
    path: Optional[List[str]] = None
    trace: Optional[Dict[str, Any]] = None
    feedbackScore: Optional[float] = Field(None, alias="feedback_score")

    model_config = ConfigDict(populate_by_name=True)

    def __getitem__(self, item):
        return getattr(self, item)

    def get(self, key, default=None):
        return getattr(self, key, default)


class GraphMemoryItem(MemoryItem):
    node: str
    compressedVecStr: Optional[str] = Field(None, alias="compressed_vec_str")
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
    from_: Optional[Union[int, float]] = Field(None, alias="from")
    to: Optional[Union[int, float]] = None
    minConfidence: Optional[float] = Field(None, alias="min_confidence")
    limit: int = 100

    model_config = ConfigDict(populate_by_name=True)

class TimelineQuery(BaseModel):
    hours: int = 24

class MaintenanceQuery(BaseModel):
    hours: int = 24

class SettingsBody(BaseModel):
    settings: Dict[str, Any]

class LgmRetrieveReq(BaseModel):
    node: str
    query: Optional[str] = None
    namespace: Optional[str] = None
    graphId: Optional[str] = Field(None, alias="graph_id")
    limit: Optional[int] = None
    includeMetadata: Optional[bool] = Field(None, alias="include_metadata")
    userId: Optional[str] = Field(None, alias="user_id")

    model_config = ConfigDict(populate_by_name=True)

class LgmContextReq(BaseModel):
    node: Optional[str] = None
    graphId: Optional[str] = Field(None, alias="graph_id")
    namespace: Optional[str] = None
    userId: Optional[str] = Field(None, alias="user_id")
    limit: Optional[int] = None

    model_config = ConfigDict(populate_by_name=True)

class LgmReflectionReq(BaseModel):
    graphId: str = Field(..., alias="graph_id")
    node: str
    content: str
    contextIds: Optional[List[str]] = Field(None, alias="context_ids")
    namespace: Optional[str] = None
    userId: Optional[str] = Field(None, alias="user_id")

    model_config = ConfigDict(populate_by_name=True)


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
    sessionId: str = Field(..., alias="session_id")
    patternCount: int = Field(..., alias="pattern_count")
    patterns: List[IdePattern] = []

    model_config = ConfigDict(populate_by_name=True)


# --- Compression Types (Parity with JS SDK) ---

class CompressionMetrics(BaseModel):
    """Metrics from vector compression."""
    originalTokens: int = Field(..., alias="original_tokens")
    compressedTokens: int = Field(..., alias="compressed_tokens")
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
    originalTokens: int = Field(..., alias="original_tokens")
    compressedTokens: int = Field(..., alias="compressed_tokens")
    saved: int
    avgRatio: float = Field(..., alias="avg_ratio")
    latency: float
    algorithms: Dict[str, int]
    updated: int

    model_config = ConfigDict(populate_by_name=True)


# --- LangGraph Result Types (Parity with JS SDK) ---

class LgStoreResult(BaseModel):
    """Result of LangGraph store operation."""
    success: bool
    memoryId: str = Field(..., alias="memory_id")
    node: str
    memory: Optional[MemoryItem] = None
    reflectionId: Optional[str] = Field(None, alias="reflection_id")

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
    reflectionId: str = Field(..., alias="reflection_id")
    insights: List[str] = []

    model_config = ConfigDict(populate_by_name=True)


# --- Dashboard/Stats Types (Parity with JS SDK) ---

class SectorStat(BaseModel):
    sector: str
    count: int
    avgSalience: float = Field(..., alias="avg_salience")

    model_config = ConfigDict(populate_by_name=True)

class DecayStats(BaseModel):
    total: int
    avgLambda: str = Field(..., alias="avg_lambda")
    minSalience: str = Field(..., alias="min_salience")
    maxSalience: str = Field(..., alias="max_salience")

    model_config = ConfigDict(populate_by_name=True)

class RequestStats(BaseModel):
    total: int
    errors: int
    errorRate: str = Field(..., alias="error_rate")
    lastHour: int = Field(..., alias="last_hour")

    model_config = ConfigDict(populate_by_name=True)

class QpsStats(BaseModel):
    peak: float
    average: float
    cacheHitRate: float = Field(..., alias="cache_hit_rate")

    model_config = ConfigDict(populate_by_name=True)

class SystemResourceStats(BaseModel):
    memoryUsage: int = Field(..., alias="memory_usage")
    heapUsed: int = Field(..., alias="heap_used")
    heapTotal: int = Field(..., alias="heap_total")
    uptime: Dict[str, int]

    model_config = ConfigDict(populate_by_name=True)

class ConfigStats(BaseModel):
    port: int
    vecDim: int = Field(..., alias="vec_dim")
    cacheSegments: int = Field(..., alias="cache_segments")
    maxActive: int = Field(..., alias="max_active")
    decayInterval: int = Field(..., alias="decay_interval")
    embedProvider: str = Field(..., alias="embed_provider")

    model_config = ConfigDict(populate_by_name=True)

class SystemStats(BaseModel):
    totalMemories: int = Field(..., alias="total_memories")
    recentMemories: int = Field(..., alias="recent_memories")
    sectorCounts: Dict[str, int] = Field(..., alias="sector_counts")
    avgSalience: str = Field(..., alias="avg_salience")
    decayStats: DecayStats = Field(..., alias="decay_stats")
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
    
    model_config = ConfigDict(populate_by_name=True)

class MaintenanceTotals(BaseModel):
    cycles: int
    reflections: int
    consolidations: int
    efficiency: Optional[int] = 0
    
    model_config = ConfigDict(populate_by_name=True)

class MaintenanceStats(BaseModel):
    operations: List[MaintenanceOperationStat]
    totals: MaintenanceTotals
    
    model_config = ConfigDict(populate_by_name=True)

class MaintenanceLog(BaseModel):
    id: int
    type: str
    status: str
    message: Optional[str] = None
    duration: Optional[int] = None
    timestamp: int = Field(..., alias="ts")
    userId: Optional[str] = Field(None, alias="user_id")

    model_config = ConfigDict(populate_by_name=True)

class MaintenanceStatus(BaseModel):
    ok: bool
    activeJobs: List[str] = Field(default_factory=list, alias="active_jobs")
    count: int

    model_config = ConfigDict(populate_by_name=True)

class SectorsResponse(BaseModel):
    sectors: List[str]
    configs: Dict[str, Any]
    stats: List[SectorStat]

    model_config = ConfigDict(populate_by_name=True)




# --- Dynamics/Graph Result Types (Parity with JS SDK) ---

class ResonanceResult(BaseModel):
    success: bool
    resonanceModulatedScore: float = Field(..., alias="resonance_modulated_score")
    parameters: Dict[str, Any]

    model_config = ConfigDict(populate_by_name=True)

class RetrievalResult(BaseModel):
    success: bool
    query: str
    sector: str
    minEnergy: float = Field(..., alias="min_energy")
    count: int
    memories: List[Dict[str, Any]]

    model_config = ConfigDict(populate_by_name=True)

class ReinforcementResult(BaseModel):
    success: bool
    propagatedCount: int = Field(..., alias="propagated_count")
    newSalience: float = Field(..., alias="new_salience")

    model_config = ConfigDict(populate_by_name=True)

class ActivationResultItem(BaseModel):
    memoryId: str = Field(..., alias="memory_id")
    activationLevel: float = Field(..., alias="activation_level")

    model_config = ConfigDict(populate_by_name=True)

class SpreadingActivationResult(BaseModel):
    success: bool
    initialCount: int = Field(..., alias="initial_count")
    iterations: int
    totalActivated: int = Field(..., alias="total_activated")
    results: List[ActivationResultItem]

    model_config = ConfigDict(populate_by_name=True)

class WaypointWeightResult(BaseModel):
    success: bool
    sourceId: str = Field(..., alias="source_id")
    targetId: str = Field(..., alias="target_id")
    weight: float
    timeGapDays: float = Field(..., alias="time_gap_days")
    details: Dict[str, bool]

    model_config = ConfigDict(populate_by_name=True)

class SalienceResult(BaseModel):
    success: bool
    calculatedSalience: float = Field(..., alias="calculated_salience")
    parameters: Dict[str, Any]

    model_config = ConfigDict(populate_by_name=True)

class TopMemory(BaseModel):
    id: str
    content: str
    sector: str
    salience: float
    lastSeen: int = Field(..., alias="last_seen")

    model_config = ConfigDict(populate_by_name=True)

class SourceRegistryEntry(BaseModel):
    userId: Optional[str] = Field(None, alias="user_id")
    type: str
    config: Optional[str] = None
    status: str
    createdAt: int = Field(0, alias="created_at")
    updatedAt: int = Field(0, alias="updated_at")

    model_config = ConfigDict(populate_by_name=True)

class ActivityItem(BaseModel):
    id: str
    type: str # 'memory' or 'event'
    sector: str
    content: str
    salience: float
    timestamp: int

    model_config = ConfigDict(populate_by_name=True)
