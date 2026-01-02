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
    decay_lambda?: number;
    /** Owner of the memory */
    user_id?: string;
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
        min_score?: number;
        /** Specific sector to search in */
        sector?: SectorType | string;
        /** Filter by owner */
        user_id?: string;
        /** Start timestamp for temporal filtering */
        startTime?: number;
        /** End timestamp for temporal filtering */
        endTime?: number;
    };
    /** Global user context for the query */
    user_id?: string;
}

/**
 * Database representation of a memory row.
 * Reflects the schema in SQLite/Postgres.
 */
export interface MemoryRow {
    id: string;
    content: string;
    primary_sector: string;
    /** JSON serialized string or null */
    tags: string | null;
    /** JSON serialized string or null */
    meta: string | null;
    user_id: string | null;
    segment: number;
    simhash: string | null;
    created_at: number;
    updated_at: number;
    last_seen_at: number;
    salience: number;
    decay_lambda: number;
    version: number;
    generated_summary: string | null;
    /** Dimension count of the mean embedding */
    mean_dim?: number;
    /** Vector blob/buffer */
    mean_vec?: Buffer | Uint8Array | null;
    /** Compressed vector blob/buffer */
    compressed_vec?: Buffer | Uint8Array | null;
    /** Learned relevance/feedback score */
    feedback_score?: number;
}

/**
 * Hydrated memory object used in business logic and APIs.
 */
export interface MemoryItem extends Omit<MemoryRow, "tags" | "meta" | "mean_vec" | "compressed_vec"> {
    /** Parsed tags as array */
    tags: string[];
    /** Parsed metadata as record */
    meta: Record<string, unknown>;
    /** Base64 encoded compressed vector for API transit */
    compressed_vec_str?: string;
}

/**
 * Standard RPC error codes following JSON-RPC 2.0.
 */
export type RpcErrorCode = -32600 | -32603;

/**
 * Knowledge ingestion request for files, links, or external connectors.
 */
export interface IngestRequest {
    source: "file" | "link" | "connector";
    content_type: "pdf" | "docx" | "html" | "md" | "txt" | "audio";
    /** Data payload (base64 for files, URI for links) */
    data: string;
    metadata?: Record<string, unknown>;
    /** Optional extraction configuration */
    config?: {
        force_root?: boolean;
        sec_sz?: number;
        lg_thresh?: number
    };
    user_id?: string;
}

/**
 * Webpage/URL-specific ingestion request.
 */
export interface IngestUrlRequest {
    url: string;
    metadata?: Record<string, unknown>;
    config?: {
        force_root?: boolean;
        sec_sz?: number;
        lg_thresh?: number
    };
    user_id?: string;
}

/**
 * Request for storing memory in a LangGraph/dynamic agent context.
 */
export interface LgmStoreRequest {
    /** Node name in the graph (e.g., 'observe', 'plan') */
    node: string;
    content: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    /** Logical grouping of context */
    namespace?: string;
    /** Specific graph instance ID */
    graph_id?: string;
    /** Whether to trigger automatic reflection */
    reflective?: boolean;
    user_id?: string;
}

/**
 * Request for retrieving context within a graph/agent session.
 */
export interface LgmRetrieveRequest {
    node: string;
    /** Semantic query for retrieval */
    query?: string;
    namespace?: string;
    graph_id?: string;
    limit?: number;
    include_metadata?: boolean;
    user_id?: string;
}

/**
 * Request for building context for a graph node.
 */
export interface LgmContextRequest {
    node: string;
    graph_id?: string;
    user_id?: string;
    limit?: number;
}

/**
 * Request for tracking reflection status.
 */
export interface LgmReflectionRequest {
    graph_id: string;
    node: string;
    content: string;
    context_ids?: string[];
    user_id?: string;
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
    session_id?: string;
}

/**
 * Fact in the Temporal Knowledge Graph.
 */
export interface TemporalFact {
    id: string;
    user_id?: string;
    subject: string;
    predicate: string;
    object: string;
    /** Start of fact validity (milliseconds) */
    valid_from: number;
    /** End of fact validity or NULL if still valid (milliseconds) */
    valid_to: number | null;
    confidence: number;
    /** Source memory ID if derived */
    source_id?: string;
    /** Timestamp of last modification */
    last_updated: number;
    metadata?: Record<string, unknown>;
}

/**
 * Edge between two temporal facts (e.g., causal, temporal_before).
 */
export interface TemporalEdge {
    id: string;
    user_id?: string;
    source_id: string;
    target_id: string;
    relation_type: string;
    /** When the relation became valid */
    valid_from: number;
    /** When the relation ceased to be valid */
    valid_to: number | null;
    weight: number;
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
    change_type: 'created' | 'updated' | 'invalidated';
}

/**
 * Query parameters for temporal retrieval.
 */
export interface TemporalQuery {
    user_id?: string;
    subject?: string;
    predicate?: string;
    object?: string;
    /** Point-in-time state query */
    at?: number | Date;
    /** Time range start */
    from?: number | Date;
    /** Time range end */
    to?: number | Date;
    min_confidence?: number;
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
    label?: string;
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
    decay_lambda: number;
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
    primary_sector: string;
    path: string[];
    salience: number;
    last_seen_at: number;
    tags?: string[];
    meta?: Record<string, unknown>;
}

/**
 * Weights for multi-vector fusion scoring.
 */
export interface MultiVecFusionWeights {
    semantic_dimension_weight: number;
    emotional_dimension_weight: number;
    procedural_dimension_weight: number;
    temporal_dimension_weight: number;
    reflective_dimension_weight: number;
}

/**
 * Waypoint in the associative memory graph.
 */
export interface Waypoint {
    src_id: string;
    dst_id: string;
    user_id: string | null;
    weight: number;
    created_at: number;
    updated_at: number;
}

// --- Backward Compatibility Aliases ---
export type add_req = AddMemoryRequest;
export type q_req = QueryMemoryRequest;
export type mem_row = MemoryRow;
export type sector_type = SectorType;
export type rpc_err_code = RpcErrorCode;
export type ingest_req = IngestRequest;
export type ingest_url_req = IngestUrlRequest;
export type lgm_store_req = LgmStoreRequest;
export type lgm_retrieve_req = LgmRetrieveRequest;
export type ide_event_req = IdeEventRequest;
export type hsg_q_result = HsgQueryResult;
export type sector_class = SectorClassification;
export type lgm_context_req = LgmContextRequest;
export type lgm_reflection_req = LgmReflectionRequest;
