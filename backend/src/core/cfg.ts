import { z } from "zod";

const envSchema = z.object({
    // Server configuration
    OM_PORT: z.coerce.number().int().positive().default(8080),
    OM_API_KEY: z.string().min(1).optional(),
    OM_MODE: z.enum(["development", "production", "langgraph"]).default("development"),

    // Database configuration
    OM_METADATA_BACKEND: z.enum(["sqlite", "postgres"]).default("sqlite"),
    OM_DB_PATH: z.string().default("./data/openmemory.sqlite"),

    // PostgreSQL specific configuration (optional)
    OM_PG_HOST: z.string().optional(),
    OM_PG_PORT: z.coerce.number().int().positive().optional(),
    OM_PG_DB: z.string().optional(),
    OM_PG_USER: z.string().optional(),
    OM_PG_PASSWORD: z.string().optional(),
    OM_PG_SSL: z.enum(["disable", "require"]).optional(),
    OM_PG_SCHEMA: z.string().optional(),
    OM_PG_TABLE: z.string().optional(),

    // Embedding and Vector configuration
    OM_EMBED_KIND: z.enum(["openai", "gemini", "ollama", "local", "router_cpu", "synthetic"]).default("synthetic"),
    // Backwards-compatible alias: some deploys use OM_EMBEDDINGS
    OM_EMBEDDINGS: z.enum(["openai", "gemini", "ollama", "local", "router_cpu", "synthetic"]).optional(),
    OM_VEC_DIM: z.coerce.number().int().positive().default(256),
    OM_EMBED_MODE: z.enum(["simple", "advanced"]).default("advanced"),
    OM_ADV_EMBED_PARALLEL: z.coerce.boolean().default(false),
    OM_EMBED_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
    OM_LOCAL_MODEL_PATH: z.string().optional(),

    // Router-specific embedding configuration
    OM_ROUTER_CACHE_TTL_MS: z.coerce.number().int().positive().default(30000),
    OM_ROUTER_FALLBACK_ENABLED: z.coerce.boolean().default(true),
    // SIMD enabled for both router fusion and generic fusion paths
    OM_ROUTER_SIMD_ENABLED: z.coerce.boolean().default(true),
    OM_ROUTER_SECTOR_MODELS: z.string().optional(),
    OM_ROUTER_DIM_TOLERANCE: z.coerce.number().min(0).max(1).default(0.1),
    OM_ROUTER_VALIDATE_ON_START: z.coerce.boolean().default(true),
    OM_ROUTER_VALIDATE_STRICT: z.coerce.boolean().default(false),
    OM_HYBRID_FUSION: z.coerce.boolean().default(true),
    OM_KEYWORD_BOOST: z.coerce.number().default(1.0),
    OM_SEG_SIZE: z.coerce.number().int().positive().default(10000),
    OM_SUMMARY_MAX_LENGTH: z.coerce.number().int().positive().default(1024),
    OM_USE_SUMMARY_ONLY: z.coerce.boolean().default(false),
    OM_CACHE_SEGMENTS: z.coerce.number().int().positive().default(3),
    OM_MAX_ACTIVE: z.coerce.number().int().positive().default(64),

    // OpenAI specific
    OM_OPENAI_KEY: z.string().optional(),
    OM_OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    OM_OPENAI_MODEL: z.string().optional(),

    // Gemini specific
    OM_GEMINI_KEY: z.string().optional(),

    // Ollama specific
    OM_OLLAMA_URL: z.string().url().default("http://localhost:11434"),
    OM_OLLAMA_AUTO_PULL: z.coerce.boolean().default(true),
    OM_OLLAMA_MULTIMODAL_ENABLED: z.coerce.boolean().default(false),
    OM_OLLAMA_DECLARATIVE_MODEL: z.string().optional(),
    OM_OLLAMA_EPISODIC_MODEL: z.string().optional(),
    OM_OLLAMA_MODELS: z.string().optional(), // Comma-separated list of models to keep loaded
    OM_OLLAMA_KEEP_ALIVE: z.string().default("5m"), // How long to keep models in memory
    OM_OLLAMA_NUM_PARALLEL: z.coerce.number().int().positive().default(1), // Parallel request limit
    OM_OLLAMA_NUM_GPU: z.coerce.number().int().default(0), // Number of GPUs (0=CPU, -1=all)

    // Rate limiting
    OM_RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
    OM_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    OM_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

    // Memory decay process
    OM_DECAY_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
    OM_DECAY_RATIO: z.coerce.number().nonnegative().default(0.5),
    OM_DECAY_SLEEP_MS: z.coerce.number().int().nonnegative().default(1000),
    OM_REFLECT_MIN: z.coerce.number().int().positive().default(20),
    OM_AUTO_REFLECT: z.coerce.boolean().default(true),
    OM_REFLECT_INTERVAL: z.coerce.number().int().positive().default(10),

    OM_USER_SUMMARY_INTERVAL: z.coerce.number().int().positive().default(30),

    // LangGraph optional settings
    OM_LG_NAMESPACE: z.string().optional(),
    OM_LG_REFLECTIVE: z.coerce.boolean().default(false),
    OM_LG_MAX_CONTEXT: z.coerce.number().int().positive().default(64),

    // Keyword extraction defaults
    OM_KEYWORD_MIN_LENGTH: z.coerce.number().int().positive().default(3),

    // Other settings
    OM_MAX_PAYLOAD_SIZE: z.coerce.number().int().positive().default(1000000), // 1MB
    OM_LOG_AUTH: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
});

let parsedEnv;
try {
    parsedEnv = envSchema.parse(process.env);
} catch (error) {
    console.error("❌ Invalid environment variables:", error);
    process.exit(1);
}

export const env = {
    port: parsedEnv.OM_PORT,
    api_key: parsedEnv.OM_API_KEY,
    mode: parsedEnv.OM_MODE,

    metadata_backend: parsedEnv.OM_METADATA_BACKEND,
    db_path: parsedEnv.OM_DB_PATH,

    // Support legacy OM_EMBEDDINGS env var: prefer it when present
    embed_kind: parsedEnv.OM_EMBEDDINGS ?? parsedEnv.OM_EMBED_KIND,
    vec_dim: parsedEnv.OM_VEC_DIM,
    embed_mode: parsedEnv.OM_EMBED_MODE,
    adv_embed_parallel: parsedEnv.OM_ADV_EMBED_PARALLEL,
    embed_delay_ms: parsedEnv.OM_EMBED_DELAY_MS,
    local_model_path: parsedEnv.OM_LOCAL_MODEL_PATH,

    // Router-specific configuration
    router_cache_ttl_ms: parsedEnv.OM_ROUTER_CACHE_TTL_MS,
    router_fallback_enabled: parsedEnv.OM_ROUTER_FALLBACK_ENABLED,
    router_simd_enabled: parsedEnv.OM_ROUTER_SIMD_ENABLED,
    router_sector_models: parsedEnv.OM_ROUTER_SECTOR_MODELS ? JSON.parse(parsedEnv.OM_ROUTER_SECTOR_MODELS) : null,
    router_dim_tolerance: parsedEnv.OM_ROUTER_DIM_TOLERANCE,
    router_validate_on_start: parsedEnv.OM_ROUTER_VALIDATE_ON_START,
    fusion_simd_enabled: parsedEnv.OM_ROUTER_SIMD_ENABLED,

    hybrid_fusion: parsedEnv.OM_HYBRID_FUSION,
    keyword_boost: parsedEnv.OM_KEYWORD_BOOST,
    seg_size: parsedEnv.OM_SEG_SIZE,
    summary_max_length: parsedEnv.OM_SUMMARY_MAX_LENGTH,
    use_summary_only: parsedEnv.OM_USE_SUMMARY_ONLY,
    cache_segments: parsedEnv.OM_CACHE_SEGMENTS,
    max_active: parsedEnv.OM_MAX_ACTIVE,

    // Backwards-compatible fallbacks: accept older env names used in some
    // deployments. Prefer the canonical OM_OPENAI_KEY when present, then
    // fall back to OM_OPENAI_API_KEY or OPENAI_API_KEY if set in the
    // environment. This allows existing docker-compose files to continue
    // working without requiring changes during a short migration window.
    openai_key: parsedEnv.OM_OPENAI_KEY ?? process.env.OM_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    openai_base_url: parsedEnv.OM_OPENAI_BASE_URL,
    openai_model: parsedEnv.OM_OPENAI_MODEL,

    // Gemini key fallback chain as well
    gemini_key: parsedEnv.OM_GEMINI_KEY ?? process.env.OM_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY,

    ollama_url: parsedEnv.OM_OLLAMA_URL,
    ollama_auto_pull: parsedEnv.OM_OLLAMA_AUTO_PULL,
    ollama_multimodal_enabled: parsedEnv.OM_OLLAMA_MULTIMODAL_ENABLED,
    ollama_declarative_model: parsedEnv.OM_OLLAMA_DECLARATIVE_MODEL,
    ollama_episodic_model: parsedEnv.OM_OLLAMA_EPISODIC_MODEL,
    ollama_models: parsedEnv.OM_OLLAMA_MODELS,
    ollama_keep_alive: parsedEnv.OM_OLLAMA_KEEP_ALIVE,
    ollama_num_parallel: parsedEnv.OM_OLLAMA_NUM_PARALLEL,
    ollama_num_gpu: parsedEnv.OM_OLLAMA_NUM_GPU,

    rate_limit_enabled: parsedEnv.OM_RATE_LIMIT_ENABLED,
    rate_limit_window_ms: parsedEnv.OM_RATE_LIMIT_WINDOW_MS,
    rate_limit_max_requests: parsedEnv.OM_RATE_LIMIT_MAX_REQUESTS,

    decay_interval_minutes: parsedEnv.OM_DECAY_INTERVAL_MINUTES,
    decay_ratio: parsedEnv.OM_DECAY_RATIO,
    decay_sleep_ms: parsedEnv.OM_DECAY_SLEEP_MS,

    max_payload_size: parsedEnv.OM_MAX_PAYLOAD_SIZE,
    log_auth: parsedEnv.OM_LOG_AUTH,

    // Reflection/langgraph and related tuning knobs
    reflect_min: parsedEnv.OM_REFLECT_MIN,
    auto_reflect: parsedEnv.OM_AUTO_REFLECT,
    reflect_interval: parsedEnv.OM_REFLECT_INTERVAL,
    user_summary_interval: parsedEnv.OM_USER_SUMMARY_INTERVAL,

    lg_namespace: parsedEnv.OM_LG_NAMESPACE,
    lg_reflective: parsedEnv.OM_LG_REFLECTIVE,
    lg_max_context: parsedEnv.OM_LG_MAX_CONTEXT,

    keyword_min_length: parsedEnv.OM_KEYWORD_MIN_LENGTH,

    // Deprecated or less-used vars kept for compatibility are now read from env schema
};

export const tier = process.env.OM_TIER || "hybrid";
export const host = process.env.OM_HOST || "localhost";
export const protocol = env.mode === "development" ? "http" : "https";
export const data_dir = process.env.OM_DATA_DIR || "./data";

// Lazy config reader: re-parse `process.env` at call-time so callers can
// obtain the current environment-derived configuration. Useful for tests
// that modify `process.env` after modules have been imported.
export function getConfig() {
    const p = envSchema.parse(process.env);
    return {
        port: p.OM_PORT,
        api_key: p.OM_API_KEY,
        mode: p.OM_MODE,

        metadata_backend: p.OM_METADATA_BACKEND,
        db_path: p.OM_DB_PATH,

        embed_kind: p.OM_EMBEDDINGS ?? p.OM_EMBED_KIND,
        vec_dim: p.OM_VEC_DIM,
        embed_mode: p.OM_EMBED_MODE,
        adv_embed_parallel: p.OM_ADV_EMBED_PARALLEL,
        embed_delay_ms: p.OM_EMBED_DELAY_MS,
        local_model_path: p.OM_LOCAL_MODEL_PATH,

        router_cache_ttl_ms: p.OM_ROUTER_CACHE_TTL_MS,
        router_fallback_enabled: p.OM_ROUTER_FALLBACK_ENABLED,
        router_simd_enabled: p.OM_ROUTER_SIMD_ENABLED,
        router_sector_models: p.OM_ROUTER_SECTOR_MODELS ? JSON.parse(p.OM_ROUTER_SECTOR_MODELS) : null,
        router_dim_tolerance: p.OM_ROUTER_DIM_TOLERANCE,
        router_validate_on_start: p.OM_ROUTER_VALIDATE_ON_START,
        fusion_simd_enabled: p.OM_ROUTER_SIMD_ENABLED,

        hybrid_fusion: p.OM_HYBRID_FUSION,
        keyword_boost: p.OM_KEYWORD_BOOST,
        seg_size: p.OM_SEG_SIZE,
        summary_max_length: p.OM_SUMMARY_MAX_LENGTH,
        use_summary_only: p.OM_USE_SUMMARY_ONLY,
        cache_segments: p.OM_CACHE_SEGMENTS,
        max_active: p.OM_MAX_ACTIVE,

        openai_key: p.OM_OPENAI_KEY ?? process.env.OM_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
        openai_base_url: p.OM_OPENAI_BASE_URL,
        openai_model: p.OM_OPENAI_MODEL,

        gemini_key: p.OM_GEMINI_KEY ?? process.env.OM_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY,

        ollama_url: p.OM_OLLAMA_URL,
        ollama_auto_pull: p.OM_OLLAMA_AUTO_PULL,
        ollama_multimodal_enabled: p.OM_OLLAMA_MULTIMODAL_ENABLED,
        ollama_declarative_model: p.OM_OLLAMA_DECLARATIVE_MODEL,
        ollama_episodic_model: p.OM_OLLAMA_EPISODIC_MODEL,
        ollama_models: p.OM_OLLAMA_MODELS,
        ollama_keep_alive: p.OM_OLLAMA_KEEP_ALIVE,
        ollama_num_parallel: p.OM_OLLAMA_NUM_PARALLEL,
        ollama_num_gpu: p.OM_OLLAMA_NUM_GPU,

        rate_limit_enabled: p.OM_RATE_LIMIT_ENABLED,
        rate_limit_window_ms: p.OM_RATE_LIMIT_WINDOW_MS,
        rate_limit_max_requests: p.OM_RATE_LIMIT_MAX_REQUESTS,

        decay_interval_minutes: p.OM_DECAY_INTERVAL_MINUTES,
        decay_ratio: p.OM_DECAY_RATIO,
        decay_sleep_ms: p.OM_DECAY_SLEEP_MS,

        max_payload_size: p.OM_MAX_PAYLOAD_SIZE,
        log_auth: p.OM_LOG_AUTH,

        reflect_min: p.OM_REFLECT_MIN,
        auto_reflect: p.OM_AUTO_REFLECT,
        reflect_interval: p.OM_REFLECT_INTERVAL,
        user_summary_interval: p.OM_USER_SUMMARY_INTERVAL,

        lg_namespace: p.OM_LG_NAMESPACE,
        lg_reflective: p.OM_LG_REFLECTIVE,
        lg_max_context: p.OM_LG_MAX_CONTEXT,

        keyword_min_length: p.OM_KEYWORD_MIN_LENGTH,
    };
}
