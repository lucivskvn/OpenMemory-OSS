/**
 * @file Master type definitions for the OpenMemory ecosystem.
 * Ensures strict consistency across core, memory, AI, and server modules.
 */

/**
 * Valid memory sectors for categorization and specialized processing.
 */
export type SectorType =
    | "episodic"
    | "semantic"
    | "procedural"
    | "emotional"
    | "reflective";

/**
 * Access control scopes for granular permissions.
 */
export type AuthScope = "memory:read" | "memory:write" | "admin:all";

/**
 * Context of the authenticated user.
 */
export interface UserContext {
    id: string;
    scopes: AuthScope[];
}

/**
 * Result of an embedding operation.
 */
export interface EmbeddingResult {
    sector: string;
    vector: number[];
    dim: number;
}

/**
 * Standard request for adding a new memory.
 */
export interface AddMemoryRequest {
    /** The actual content of the memory */
    content: string;
    /** Optional tags for categorization */
    tags?: string[];
    /** Structured metadata */
    metadata?: Record<string, unknown>;
    /** Initial salience (importance) score (0-1) */
    salience?: number;
    /** Frequency of decay for this memory */
    decayLambda?: number;
    /** Owner of the memory or 'null' for anonymous */
    userId?: string | null;
}

/**
 * Request for batch memory insertion.
 */
export interface BatchAddRequest {
    items: AddMemoryRequest[];
    userId?: string | null;
}

/**
 * Semantic search request with optional filtering.
 */
export interface QueryMemoryRequest {
    /** Natural language or keyword query */
    query: string;
    /** Number of results to return */
    k?: number;
    /** Filtering criteria */
    filters?: {
        /** Search only memories with these tags */
        tags?: string[];
        /** Minimum similarity/relevance score */
        minScore?: number;
        /** Specific sector to search in */
        sector?: SectorType | string;
        /** Filter by owner */
        userId?: string | null;
        /** Start timestamp for temporal filtering */
        startTime?: number;
        /** End timestamp for temporal filtering */
        endTime?: number;
    };
    /** Global user context for the query (Anonymous if null, System if undefined) */
    userId?: string | null;
}

/**
 * Database representation of a memory row.
 * Reflects the schema in SQLite/Postgres.
 */
export interface MemoryRow {
    id: string;
    content: string;
    primarySector: string;
    /** JSON serialized string or null */
    tags: string | null;
    /** JSON serialized string or null */
    metadata: string | null;
    userId: string | null;
    segment: number;
    simhash: string | null;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    salience: number;
    decayLambda: number;
    version: number;
    generatedSummary: string | null;
    /** Dimension count of the mean embedding */
    meanDim?: number;
    /** Vector blob/buffer */
    meanVec?: Buffer | Uint8Array | null;
    /** Compressed vector blob/buffer */
    compressedVec?: Buffer | Uint8Array | null;
    /** Learned relevance/feedback score */
    feedbackScore?: number;
}

/**
 * Item structure for batch memory insertion.
 * Aligns with the arguments of `insMem`.
 */
export interface BatchMemoryInsertItem {
    id: string;
    content: string;
    primarySector: string; // Renamed from sector for DB parity
    tags: string | null;
    metadata: string | null;
    userId: string | null;
    segment: number;
    simhash: string | null;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    salience: number;
    decayLambda: number;
    version: number;
    meanDim: number;
    meanVec: Buffer | Uint8Array;
    compressedVec: Buffer | Uint8Array;
    feedbackScore: number;
    generatedSummary: string | null;
}

/**
 * Item structure for batch waypoint insertion.
 * Aligns with the arguments of `insWaypoint`.
 */
export interface BatchWaypointInsertItem {
    srcId: string;
    dstId: string;
    userId: string | null | undefined;
    weight: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * Hydrated memory object used in business logic and APIs.
 */
export interface MemoryItem extends Omit<
    MemoryRow,
    "tags" | "metadata" | "meanVec" | "compressedVec"
> {
    /** Parsed tags as array */
    tags: string[];
    /** Parsed metadata as record */
    metadata: Record<string, unknown>;
    /** Base64 encoded compressed vector for API transit */
    compressedVecStr?: string;
    [key: string]: unknown; // Allow for dynamic payload properties
}

/**
 * Standard RPC error codes following JSON-RPC 2.0.
 * @see https://www.jsonrpc.org/specification#error_object
 *
 * -32700: Parse error - Invalid JSON
 * -32600: Invalid Request - Not a valid Request object
 * -32601: Method not found
 * -32602: Invalid params
 * -32603: Internal error
 */
export type RpcErrorCode =
    | -32700 // Parse error
    | -32600 // Invalid Request
    | -32601 // Method not found
    | -32602 // Invalid params
    | -32603; // Internal error

/**
 * Knowledge ingestion request for files, links, or external connectors.
 */
export interface IngestRequest {
    source: "file" | "link" | "connector" | string;
    contentType: string;
    /** Data payload (base64 for files, URI for links, or Buffer) */
    data: string | Buffer | Uint8Array;
    metadata?: Record<string, unknown>;
    /** Optional extraction configuration */
    config?: IngestionConfig;
    userId?: string | null;
}

/**
 * Webpage/URL-specific ingestion request.
 */
export interface IngestUrlRequest {
    url: string;
    metadata?: Record<string, unknown>;
    config?: IngestionConfig;
    userId?: string | null;
}

/**
 * Configuration for document and URL ingestion.
 */
export interface IngestionConfig {
    forceRoot?: boolean;
    secSz?: number;
    lgThresh?: number;
    fastSummarize?: boolean;
}

/**
 * Result of the ingestion process.
 */
export interface IngestionResult {
    rootMemoryId: string;
    childCount: number;
    totalTokens: number;
    strategy: "single" | "root-child";
    extraction: Record<string, unknown>;
}

/**
 * Request for storing memory in a LangGraph/dynamic agent context.
 */
export interface LgmStoreRequest {
    /** Node name in the graph (e.g., 'observe', 'plan') */
    node: string;
    content?: string;
    memoryId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    /** Logical grouping of context */
    namespace?: string;
    /** Specific graph instance ID */
    graphId?: string;
    /** Whether to trigger automatic reflection */
    reflective?: boolean;
    userId?: string | null;
}

/**
 * Request for retrieving context within a graph/agent session.
 */
export interface LgmRetrieveRequest {
    node: string;
    /** Semantic query for retrieval */
    query?: string;
    namespace?: string;
    graphId?: string;
    limit?: number;
    includeMetadata?: boolean;
    userId?: string | null;
}

/**
 * Request for building context for a graph node.
 */
export interface LgmContextRequest {
    node?: string;
    graphId?: string;
    namespace?: string;
    userId?: string | null;
    limit?: number;
}

/**
 * Request for tracking reflection status.
 */
export interface LgmReflectionRequest {
    graphId?: string;
    node: string;
    content?: string;
    contextIds?: string[];
    namespace?: string;
    userId?: string | null;
    depth?: "shallow" | "deep";
}

/**
 * System event captured from IDE extensions.
 */
export interface IdeEventRequest {
    event:
    | "edit"
    | "open"
    | "close"
    | "save"
    | "refactor"
    | "comment"
    | "pattern_detected"
    | "api_call"
    | "definition"
    | "reflection";
    file?: string;
    snippet?: string;
    comment?: string;
    metadata: {
        project?: string;
        lang?: string;
        user?: string;
        timestamp?: number;
        [key: string]: unknown;
    };
    sessionId?: string;
}

export interface TemporalFactRow {
    id: string;
    userId: string | null;
    subject: string;
    predicate: string;
    object: string;
    validFrom: number;
    validTo: number | null;
    confidence: number;
    lastUpdated: number;
    metadata: string | null;
}

export interface TemporalEdgeRow {
    id: string;
    userId: string | null;
    sourceId: string;
    targetId: string;
    relationType: string;
    validFrom: number;
    validTo: number | null;
    weight: number;
    lastUpdated: number;
    metadata: string | null;
}

/**
 * Fact in the Temporal Knowledge Graph.
 */
export interface TemporalFact {
    id: string;
    userId?: string | null;
    subject: string;
    predicate: string;
    object: string;
    /** Start of fact validity (milliseconds) */
    validFrom: number;
    /** End of fact validity or NULL if still valid (milliseconds) */
    validTo: number | null;
    confidence: number;
    /** Source memory ID if derived */
    sourceId?: string;
    /** Timestamp of last modification */
    lastUpdated: number;
    metadata?: Record<string, unknown>;
}

/**
 * Edge between two temporal facts (e.g., causal, temporal_before).
 */
export interface TemporalEdge {
    id: string;
    userId?: string | null;
    sourceId: string;
    targetId: string;
    relationType: string;
    /** When the relation became valid */
    validFrom: number;
    /** When the relation ceased to be valid */
    validTo: number | null;
    weight: number;
    /** Timestamp of last modification */
    lastUpdated: number;
    metadata?: Record<string, unknown>;
}

/**
 * Timeline event showing fact state changes.
 */
export interface TimelineEntry {
    timestamp: number;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    changeType: "created" | "updated" | "invalidated";
}

/**
 * Query parameters for temporal retrieval.
 */
export interface TemporalQuery {
    userId?: string | null;
    subject?: string;
    predicate?: string;
    object?: string;
    /** Point-in-time state query */
    at?: number | Date;
    /** Time range start */
    from?: number | Date;
    /** Time range end */
    to?: number | Date;
    minConfidence?: number;
}

/**
 * Visualization node for graph components.
 */
export interface GraphNode {
    id: string;
    label: string;
    /** Group/Type for coloring */
    group?: string;
    /** Relative importance/size */
    val?: number;
}

/**
 * Visualization link for graph components.
 */
export interface GraphLink {
    source: string;
    target: string;
    /** Relationship label (required for visualization) */
    label: string;
    confidence?: number;
}

/**
 * Aggregate graph structure for visualization.
 */
export interface GraphData {
    nodes: GraphNode[];
    links: GraphLink[];
}

/**
 * Configuration for a memory sector (e.g., episodic, procedural).
 */
export interface SectorConfig {
    model: string;
    decayLambda: number;
    weight: number;
    patterns: RegExp[];
}

/**
 * Result of content classification.
 */
export interface SectorClassification {
    primary: string;
    additional: string[];
    confidence: number;
}

/**
 * Result of a HSG (Hyper Semantic Graph) query.
 */
export interface HsgQueryResult {
    id: string;
    content: string;
    score: number;
    sectors: string[];
    primarySector: string;
    path: string[];
    salience: number;
    lastSeenAt: number;
    createdAt: number;
    tags?: string[];
    metadata?: Record<string, unknown>;
    userId?: string | null;
    updatedAt: number;
    decayLambda?: number;
    version?: number;
    segment?: number;
    simhash?: string | null;
    generatedSummary?: string | null;
}

/**
 * Weights for multi-vector fusion scoring.
 */
export interface MultiVecFusionWeights {
    semanticDimensionWeight: number;
    emotionalDimensionWeight: number;
    proceduralDimensionWeight: number;
    temporalDimensionWeight: number;
    reflectiveDimensionWeight: number;
}

/**
 * Waypoint in the associative memory graph.
 */
export interface Waypoint {
    srcId: string;
    dstId: string;
    userId: string | null;
    weight: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * Statistics for a cognitive sector.
 */
export interface SectorStat {
    sector: string;
    count: number;
    avgSalience: number;
}

/**
 * Entry in the embedding logs.
 */
export interface LogEntry {
    id: string;
    model: string;
    status: string;
    ts: number;
    err: string | null;
    userId?: string | null;
}

/**
 * Statistics relative to Temporal Graph data.
 */
export interface TemporalStatsResult {
    activeFacts: number;
    historicalFacts: number;
    totalFacts: number;
    historicalPercentage: string;
}

/**
 * Analysis of fact volatility over time.
 */
export interface VolatileFactsResult {
    subject?: string;
    limit: number;
    volatileFacts: {
        fact: TemporalFact;
        changeCount: number;
        frequency: number;
    }[];
    count: number;
}

export interface SystemStats {
    totalMemories: number;
    recentMemories: number;
    sectorCounts: Record<string, number>;
    avgSalience: string;
    decayStats: {
        total: number;
        avgLambda: string;
        minSalience: string;
        maxSalience: string;
    };
    requests: {
        total: number;
        errors: number;
        errorRate: string;
        lastHour: number;
    };
    qps: {
        peak: number;
        average: number;
        cacheHitRate: number;
    };
    counts: {
        memories: number;
        vectors: number;
        facts: number;
        edges: number;
    };
    system: {
        memoryUsage: number;
        heapUsed: number;
        heapTotal: number;
        uptime: {
            seconds: number;
            days: number;
            hours: number;
        };
    };
    config: {
        port: number;
        vecDim: number;
        cacheSegments: number;
        maxActive: number;
        decayInterval: number;
        embedProvider: string;
        embedModel: string;
        embedKind: string;
    };
}

export interface SystemMetrics {
    memory: {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
    };
    cpu: {
        user: number;
        system: number;
    };
    uptime: number;
    connections: {
        active: number;
        pool: Record<string, unknown>;
    };
    jobs: {
        active: number;
        names: string[];
    };
    version: string;
}

export interface ActivityItem {
    id: string;
    type: string;
    sector: string;
    content: string;
    salience: number;
    timestamp: number;
}

export interface TopMemory {
    id: string;
    content: string;
    sector: string;
    salience: number;
    lastSeen: number;
}

export interface TimelineBucket {
    primarySector: string;
    label: string;
    sortKey: string;
    count: number;
    hour: string;
}

export interface SystemTimelineBucket {
    bucket_key: string;
    timestamp_ms: number;
    counts: Record<string, number>;
}

export interface MaintenanceStats {
    operations: {
        hour: string;
        decay: number;
        reflection: number;
        consolidation: number;
    }[];
    totals: {
        cycles: number;
        reflections: number;
        consolidations: number;
    };
}

/**
 * Result of comparing facts between two timepoints.
 */
export interface TemporalComparisonResult {
    subject: string;
    time1: string;
    time2: string;
    added: TemporalFact[];
    removed: TemporalFact[];
    changed: {
        predicate: string;
        old: TemporalFact;
        new: TemporalFact;
    }[];
    unchanged: TemporalFact[];
    summary: {
        added: number;
        removed: number;
        changed: number;
        unchanged: number;
    };
}

/**
 * Metadata about a configured data source.
 */
export interface SourceRegistryEntry {
    userId: string;
    type: string;
    config: string;
    status: "enabled" | "disabled" | string;
    createdAt: number;
    updatedAt: number;
}

/**
 * Result of a resonance calculation.
 */
export interface ResonanceResult {
    success: boolean;
    resonanceModulatedScore: number;
    parameters: Record<string, unknown>;
}

/**
 * Result of energy-based memory retrieval.
 */
export interface RetrievalResult {
    success: boolean;
    query: string;
    sector: string;
    minEnergy: number;
    count: number;
    memories: {
        id: string;
        content: string;
        primarySector: string;
        salience: number;
        activationEnergy: number;
    }[];
}

/**
 * Result of a reinforcement operation.
 */
export interface ReinforcementResult {
    success: boolean;
    propagatedCount: number;
    newSalience: number;
}

/**
 * Result of a spreading activation simulation.
 */
export interface SpreadingActivationResult {
    success: boolean;
    initialCount: number;
    iterations: number;
    totalActivated: number;
    results: {
        memoryId: string;
        activationLevel: number;
    }[];
}

/**
 * Associative Waypoint Graph structure.
 */
export interface WaypointGraphResult {
    success: boolean;
    stats: {
        totalNodes: number;
        totalEdges: number;
        averageEdgesPerNode: number;
        disconnectedNodes: number;
    };
    nodes: {
        memoryId: string;
        edgeCount: number;
        connections: {
            targetId: string;
            weight: number;
            timeGapMs: number;
        }[];
    }[];
}

/**
 * Result of a waypoint weight calculation.
 */
export interface WaypointWeightResult {
    success: boolean;
    sourceId: string;
    targetId: string;
    weight: number;
    timeGapDays: number;
    details: {
        temporalDecay: boolean;
        cosineSimilarity: boolean;
    };
}

/**
 * Configuration constants for the Dynamics module.
 */
export interface DynamicsConstants {
    decay: {
        lambda: number;
        halflife: number;
        minSalience: number;
    };
    weights: {
        recency: number;
        frequency: number;
        emotional: number;
    };
    thresholds: {
        retrieval: number;
        consolidation: number;
    };
}

/**
 * Result of a salience calculation.
 */
export interface SalienceResult {
    success: boolean;
    calculatedSalience: number;
    parameters: Record<string, unknown>;
}

// --- Client/Event DTOs (Moved from Client SDK) ---

export interface MemoryAddedPayload {
    id: string;
    primarySector: string;
    content: string;
    userId?: string | null;
    [key: string]: unknown;
}

export interface IdeSuggestionPayload {
    sessionId: string;
    count: number;
    topPattern: IdePattern;
    userId?: string;
}

export interface IdeSessionPayload {
    sessionId: string;
    status: "started" | "ended";
    projectName?: string;
    summary?: string;
    userId?: string;
}

export type OpenMemoryEvent =
    | { type: "connected"; timestamp: number }
    | { type: "heartbeat"; timestamp: number }
    | { type: "memory_added"; data: MemoryAddedPayload; timestamp: number }
    | {
        type: "memory_updated";
        data: { id: string; userId?: string | null };
        timestamp: number;
    }
    | { type: "ide_suggestion"; data: IdeSuggestionPayload; timestamp: number }
    | { type: "ide_session_update"; data: IdeSessionPayload; timestamp: number }
    | {
        type: "temporal:fact:created";
        data: {
            id: string;
            userId?: string | null;
            subject: string;
            predicate: string;
            object: string;
            validFrom: number;
            validTo: number | null;
            confidence: number;
            metadata?: Record<string, unknown>;
        };
        timestamp: number;
    }
    | {
        type: "temporal:fact:updated";
        data: {
            id: string;
            userId?: string | null;
            confidence?: number;
            metadata?: Record<string, unknown>;
        };
        timestamp: number;
    }
    | {
        type: "temporal:fact:deleted";
        data: { id: string; userId?: string | null; validTo: number };
        timestamp: number;
    }
    | {
        type: "temporal:edge:created";
        data: {
            id: string;
            userId?: string | null;
            sourceId: string;
            targetId: string;
            relationType: string;
            validFrom: number;
            weight: number;
            metadata?: Record<string, unknown>;
            validTo: number | null;
        };
        timestamp: number;
    }
    | {
        type: "temporal:edge:updated";
        data: {
            id: string;
            userId?: string | null;
            weight?: number;
            metadata?: Record<string, unknown>;
        };
        timestamp: number;
    }
    | {
        type: "temporal:edge:deleted";
        data: { id: string; userId?: string | null; validTo: number };
        timestamp: number;
    };

export interface MaintLogEntry {
    id: number;
    op: string; // 'routine', 'decay', etc.
    status: string;
    details: string;
    ts: number;
    userId: string | null;
}

export interface IdeContextItem {
    memoryId: string;
    content: string;
    primarySector: string;
    sectors: string[];
    score: number;
    salience: number;
    lastSeenAt: number;
    path: string[];
}

export interface IdeContextResult {
    success: boolean;
    context: IdeContextItem[];
    query: string;
}

// --- Compression Types ---

export interface CompressionMetrics {
    originalTokens: number;
    compressedTokens: number;
    ratio: number;
    saved: number;
    pct: number;
    latency: number;
    algorithm: string;
    timestamp: number;
}

export interface CompressionResult {
    og: string;
    comp: string;
    metrics: CompressionMetrics;
    hash: string;
}

export interface CompressionStats {
    total: number;
    originalTokens: number;
    compressedTokens: number;
    saved: number;
    avgRatio: number;
    latency: number;
    algorithms: Record<string, number>;
    updated: number;
}

export interface IdePattern {
    patternId: string;
    description: string;
    salience: number;
    detectedAt: number;
    lastReinforced: number;
    confidence?: number;
    affectedFiles?: string[];
}

export interface IdePatternsResult {
    success: boolean;
    sessionId: string;
    patternCount: number;
    patterns: IdePattern[];
}

// --- LangGraph Interfaces ---

export interface LgConfig {
    success: boolean;
    config: {
        nodes: string[];
        edges: { source: string; target: string }[];
    };
}

export interface LgStoreResult {
    success: boolean;
    memoryId: string;
    node: string;
    memory?: MemoryItem | null;
}

export interface LgRetrieveResult {
    success: boolean;
    memories: MemoryItem[];
}

/**
 * Context item for a specific LangGraph node.
 */
export interface LgNodeContext {
    /** Node name (e.g., 'observe', 'plan', 'reflect') */
    node: string;
    /** Memory items associated with this node */
    items: MemoryItem[];
}

export interface LgContextResult {
    success: boolean;
    /** Combined context string from all nodes */
    context: string;
    /** List of node names that contributed to the context */
    sources: string[];
    /** Detailed context per node */
    nodes?: LgNodeContext[];
}

export interface LgReflectResult {
    success: boolean;
    reflectionId: string;
    insights: string[];
}

// --- User Interfaces ---

export interface UserProfile {
    id: string;
    username: string;
    email?: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
}

export interface UserSummary {
    userId: string | null;
    summary: string;
    lastUpdated: number;
    generatedAt: number;
}

export interface UserMemoriesResult {
    memories: MemoryItem[];
    total: number;
}

// --- Sources Interfaces ---

export interface SourceListResult {
    sources: string[];
    usage: Record<string, number>;
}

export interface IngestSourceResult {
    success: boolean;
    result: unknown;
}

/**
 * API Key metadata.
 */
export interface ApiKey {
    id: string;             // Unique ID
    keyPrefix: string;      // First few chars
    description: string;
    scopes: string[];
    createdAt: number;
    lastUsedAt?: number;
}
