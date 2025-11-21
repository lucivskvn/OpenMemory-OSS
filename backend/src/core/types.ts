/**
 * Embedding Provider Types
 * Maps to OM_EMBED_KIND environment variable
 */
export type EmbeddingProvider =
  | 'synthetic'  // Fast, deterministic embeddings for testing
  | 'openai'     // Cloud API with high-quality embeddings
  | 'gemini'     // Google's embedding API
  | 'ollama'     // Local models via Ollama
  | 'local'      // Custom local embedding models
  | 'router_cpu'; // CPU-optimized sector routing

/**
 * Embedding Batch Mode Types
 * Maps to OM_EMBED_MODE environment variable
 */
export type EmbeddingBatchMode =
  | 'simple'     // Single embedding call per query
  | 'advanced';   // Per-sector parallel embeddings

/**
 * Telemetry Metadata Structure for Chat/Memory Requests
 * Used for backend observability and potential future routing decisions
 */
export interface EmbeddingTelemetryMetadata {
  /** Selected embedding provider (e.g., 'router_cpu') */
  embedding_provider?: EmbeddingProvider;

  /** Batching mode ('simple' or 'advanced') */
  batch_mode?: EmbeddingBatchMode;

  /** Global SIMD enabled status (affects all providers) */
  simd_global_enabled?: boolean;

  /** Router SIMD enabled status (router_cpu only) */
  router_simd_enabled?: boolean;

  /** Router fallback enabled status (router_cpu only) */
  fallback_enabled?: boolean;

  /** Number of sectors configured (router_cpu only) */
  sector_models_summary?: number;

  /** Additional telemetry fields for forward compatibility */
  [key: string]: unknown;
}

/**
 * Query Request with Optional Telemetry Metadata
 */
export interface QueryRequest {
  query: string;
  top_k?: number;
  threshold?: number;
  user_id?: string;
  metadata?: EmbeddingTelemetryMetadata; // Telemetry for observability
  [key: string]: unknown; // Allow additional fields for compatibility
}

/**
 * Chat Request with Optional Telemetry Metadata
 */
export interface ChatRequest extends QueryRequest {
  message?: string;
  conversation_id?: string;
  context?: Record<string, unknown>;
  system_message?: string;
  temperature?: number;
  max_tokens?: number;
  // Embedding telemetry metadata can help with routing decisions
  metadata?: EmbeddingTelemetryMetadata;
}

/**
 * LangGraph Memory Types
 */
export type sector_type = "episodic" | "semantic" | "reflective" | "procedural" | "emotional";

export interface lgm_store_req {
  node: string;
  content: string;
  namespace?: string;
  graph_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  reflective?: boolean;
}

export interface lgm_retrieve_req {
  node: string;
  namespace?: string;
  graph_id?: string;
  limit?: number;
  include_metadata?: boolean;
  query?: string;
}

export interface lgm_context_req {
  namespace?: string;
  graph_id?: string;
  limit?: number;
}

export interface lgm_reflection_req {
  namespace?: string;
  graph_id?: string;
  context_ids?: string[];
  node?: string;
  content?: string;
}

export interface mem_row {
  id: string;
  primary_sector: sector_type;
  salience: number;
  last_seen_at: number;
  user_id?: string | null;
  content: string;
  tags?: string | null;
  meta?: string | null;
  created_at: number;
  updated_at: number;
  decay_lambda: number;
  version: number;
}

export type rpc_err_code = string;
