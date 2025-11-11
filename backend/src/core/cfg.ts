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
    OM_EMBED_KIND: z.enum(["openai", "gemini", "ollama", "local", "synthetic"]).default("synthetic"),
    OM_VEC_DIM: z.coerce.number().int().positive().default(256),
    OM_EMBED_MODE: z.enum(["simple", "advanced"]).default("advanced"),
    OM_ADV_EMBED_PARALLEL: z.coerce.boolean().default(false),
    OM_EMBED_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
    OM_LOCAL_MODEL_PATH: z.string().optional(),
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
    OM_OLLAMA_DECLARATIVE_MODEL: z.string().optional(),
    OM_OLLAMA_EPISODIC_MODEL: z.string().optional(),

    // Rate limiting
    OM_RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
    OM_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    OM_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

    // Memory decay process
    OM_DECAY_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),

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

    embed_kind: parsedEnv.OM_EMBED_KIND,
    vec_dim: parsedEnv.OM_VEC_DIM,
    embed_mode: parsedEnv.OM_EMBED_MODE,
    adv_embed_parallel: parsedEnv.OM_ADV_EMBED_PARALLEL,
    embed_delay_ms: parsedEnv.OM_EMBED_DELAY_MS,
    local_model_path: parsedEnv.OM_LOCAL_MODEL_PATH,
    hybrid_fusion: parsedEnv.OM_HYBRID_FUSION,
    keyword_boost: parsedEnv.OM_KEYWORD_BOOST,
    seg_size: parsedEnv.OM_SEG_SIZE,
    summary_max_length: parsedEnv.OM_SUMMARY_MAX_LENGTH,
    use_summary_only: parsedEnv.OM_USE_SUMMARY_ONLY,
    cache_segments: parsedEnv.OM_CACHE_SEGMENTS,
    max_active: parsedEnv.OM_MAX_ACTIVE,

    openai_key: parsedEnv.OM_OPENAI_KEY,
    openai_base_url: parsedEnv.OM_OPENAI_BASE_URL,
    openai_model: parsedEnv.OM_OPENAI_MODEL,

    gemini_key: parsedEnv.OM_GEMINI_KEY,

    ollama_url: parsedEnv.OM_OLLAMA_URL,
    ollama_declarative_model: parsedEnv.OM_OLLAMA_DECLARATIVE_MODEL,
    ollama_episodic_model: parsedEnv.OM_OLLAMA_EPISODIC_MODEL,

    rate_limit_enabled: parsedEnv.OM_RATE_LIMIT_ENABLED,
    rate_limit_window_ms: parsedEnv.OM_RATE_LIMIT_WINDOW_MS,
    rate_limit_max_requests: parsedEnv.OM_RATE_LIMIT_MAX_REQUESTS,

    decay_interval_minutes: parsedEnv.OM_DECAY_INTERVAL_MINUTES,

    max_payload_size: parsedEnv.OM_MAX_PAYLOAD_SIZE,
    log_auth: parsedEnv.OM_LOG_AUTH,

    // Deprecated or less-used vars kept for compatibility are now read from env schema
};

export const tier = process.env.OM_TIER || "hybrid";
export const host = process.env.OM_HOST || "localhost";
export const protocol = env.mode === "development" ? "http" : "https";
export const data_dir = process.env.OM_DATA_DIR || "./data";
