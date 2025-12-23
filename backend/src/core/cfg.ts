import path from "path";
import { z } from "zod";

// Helper transformers
const toNum = (def: number) => z.string().optional().transform(v => v ? Number(v) : def);
const toBool = (def: boolean = false) => z.string().optional().transform(v => v === "true" || (v !== "false" && def));
const toStr = (def: string) => z.string().optional().transform(v => v || def);

type tier = "fast" | "smart" | "deep" | "hybrid";

const get_tier = (): tier => {
    const man = process.env.OM_TIER as tier;
    if (man && ["fast", "smart", "deep", "hybrid"].includes(man)) return man;
    console.warn(
        "[OpenMemory] OM_TIER not set! Please set OM_TIER=hybrid|fast|smart|deep in .env",
    );
    return "hybrid";
};
export const tier = get_tier();
const tier_dims = { fast: 256, smart: 384, deep: 1536, hybrid: 256 };
const tier_cache = { fast: 2, smart: 3, deep: 5, hybrid: 3 };
const tier_max_active = { fast: 32, smart: 64, deep: 128, hybrid: 64 };

const envSchema = z.object({
    port: toNum(8080),
    db_path: z.string().optional().transform(v => v || path.resolve(process.cwd(), "data/openmemory.sqlite")),
    api_key: z.string().optional(),
    rate_limit_enabled: toBool(),
    rate_limit_window_ms: toNum(60000),
    rate_limit_max_requests: toNum(100),
    compression_enabled: toBool(),
    compression_algorithm: z.enum(["semantic", "syntactic", "aggressive", "auto"]).default("auto"),
    compression_min_length: toNum(100),
    emb_kind: toStr("synthetic"),
    embedding_fallback: toStr("synthetic").transform(v => v.split(",").map(s => s.trim()).filter(Boolean)),
    embed_mode: toStr("simple"),
    adv_embed_parallel: toBool(),
    embed_delay_ms: toNum(200),
    openai_key: z.string().optional(),
    openai_base_url: toStr("https://api.openai.com/v1"),
    openai_model: z.string().optional(),
    gemini_key: z.string().optional(),
    AWS_REGION: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    ollama_url: toStr("http://localhost:11434"),
    local_model_path: z.string().optional(),
    vec_dim: toNum(tier_dims[tier]),
    min_score: toNum(0.3),
    decay_lambda: toNum(0.02),
    decay_interval_minutes: toNum(1440),
    max_payload_size: toNum(1_000_000),
    mode: toStr("standard").transform(v => v.toLowerCase()),
    lg_namespace: toStr("default"),
    lg_max_context: toNum(50),
    lg_reflective: toBool(true),
    metadata_backend: toStr("sqlite").transform(v => v.toLowerCase()),
    vector_backend: toStr("postgres").transform(v => v.toLowerCase()),
    valkey_host: toStr("localhost"),
    valkey_port: toNum(6379),
    valkey_password: z.string().optional(),
    ide_mode: toBool(),
    ide_allowed_origins: toStr("http://localhost:5173,http://localhost:3000").transform(v => v.split(",")),
    auto_reflect: toBool(),
    reflect_interval: toNum(10),
    reflect_min: toNum(20),
    user_summary_interval: toNum(30),
    use_summary_only: toBool(true),
    summary_max_length: toNum(200),
    seg_size: toNum(10000),
    cache_segments: toNum(tier_cache[tier]),
    max_active: toNum(tier_max_active[tier]),
    decay_ratio: toNum(0.03),
    decay_sleep_ms: toNum(200),
    decay_threads: toNum(3),
    decay_cold_threshold: toNum(0.25),
    decay_reinforce_on_query: toBool(true),
    regeneration_enabled: toBool(true),
    max_vector_dim: toNum(tier_dims[tier]),
    min_vector_dim: toNum(64),
    summary_layers: toNum(3),
    keyword_boost: toNum(2.5),
    keyword_min_length: toNum(3),
});

// Map process.env to schema keys (handling alias/overrides logic manually for complex cases)
const rawEnv = {
    ...process.env,
    port: process.env.OM_PORT,
    db_path: process.env.OM_DB_PATH,
    api_key: process.env.OM_API_KEY,
    rate_limit_enabled: process.env.OM_RATE_LIMIT_ENABLED,
    rate_limit_window_ms: process.env.OM_RATE_LIMIT_WINDOW_MS,
    rate_limit_max_requests: process.env.OM_RATE_LIMIT_MAX_REQUESTS,
    compression_enabled: process.env.OM_COMPRESSION_ENABLED,
    compression_algorithm: process.env.OM_COMPRESSION_ALGORITHM,
    compression_min_length: process.env.OM_COMPRESSION_MIN_LENGTH,
    emb_kind: process.env.OM_EMBEDDINGS,
    embedding_fallback: process.env.OM_EMBEDDING_FALLBACK,
    embed_mode: process.env.OM_EMBED_MODE,
    adv_embed_parallel: process.env.OM_ADV_EMBED_PARALLEL,
    embed_delay_ms: process.env.OM_EMBED_DELAY_MS,
    openai_key: process.env.OPENAI_API_KEY || process.env.OM_OPENAI_API_KEY,
    openai_base_url: process.env.OM_OPENAI_BASE_URL,
    openai_model: process.env.OM_OPENAI_MODEL,
    gemini_key: process.env.GEMINI_API_KEY || process.env.OM_GEMINI_API_KEY,
    ollama_url: process.env.OLLAMA_URL || process.env.OM_OLLAMA_URL,
    local_model_path: process.env.LOCAL_MODEL_PATH || process.env.OM_LOCAL_MODEL_PATH,
    vec_dim: process.env.OM_VEC_DIM,
    min_score: process.env.OM_MIN_SCORE,
    decay_lambda: process.env.OM_DECAY_LAMBDA,
    decay_interval_minutes: process.env.OM_DECAY_INTERVAL_MINUTES,
    max_payload_size: process.env.OM_MAX_PAYLOAD_SIZE,
    mode: process.env.OM_MODE,
    lg_namespace: process.env.OM_LG_NAMESPACE,
    lg_max_context: process.env.OM_LG_MAX_CONTEXT,
    lg_reflective: process.env.OM_LG_REFLECTIVE,
    metadata_backend: process.env.OM_METADATA_BACKEND,
    vector_backend: process.env.OM_VECTOR_BACKEND,
    valkey_host: process.env.OM_VALKEY_HOST,
    valkey_port: process.env.OM_VALKEY_PORT,
    valkey_password: process.env.OM_VALKEY_PASSWORD,
    ide_mode: process.env.OM_IDE_MODE,
    ide_allowed_origins: process.env.OM_IDE_ALLOWED_ORIGINS,
    auto_reflect: process.env.OM_AUTO_REFLECT,
    reflect_interval: process.env.OM_REFLECT_INTERVAL,
    reflect_min: process.env.OM_REFLECT_MIN_MEMORIES,
    user_summary_interval: process.env.OM_USER_SUMMARY_INTERVAL,
    use_summary_only: process.env.OM_USE_SUMMARY_ONLY,
    summary_max_length: process.env.OM_SUMMARY_MAX_LENGTH,
    seg_size: process.env.OM_SEG_SIZE,
    cache_segments: process.env.OM_CACHE_SEGMENTS,
    max_active: process.env.OM_MAX_ACTIVE,
    decay_ratio: process.env.OM_DECAY_RATIO,
    decay_sleep_ms: process.env.OM_DECAY_SLEEP_MS,
    decay_threads: process.env.OM_DECAY_THREADS,
    decay_cold_threshold: process.env.OM_DECAY_COLD_THRESHOLD,
    decay_reinforce_on_query: process.env.OM_DECAY_REINFORCE_ON_QUERY,
    regeneration_enabled: process.env.OM_REGENERATION_ENABLED,
    max_vector_dim: process.env.OM_MAX_VECTOR_DIM,
    min_vector_dim: process.env.OM_MIN_VECTOR_DIM,
    summary_layers: process.env.OM_SUMMARY_LAYERS,
    keyword_boost: process.env.OM_KEYWORD_BOOST,
    keyword_min_length: process.env.OM_KEYWORD_MIN_LENGTH,
};

let parsed;
try {
    parsed = envSchema.parse(rawEnv);
} catch (e: any) {
    console.error("[CONFIG] Invalid configuration:", e.errors);
    process.exit(1);
}

export const env = parsed;

export const authConfig = {
    api_key: env.api_key,
    api_key_header: "x-api-key",
    rate_limit_enabled: env.rate_limit_enabled,
    rate_limit_window_ms: env.rate_limit_window_ms,
    rate_limit_max_requests: env.rate_limit_max_requests,
    public_endpoints: [
        "/health",
        "/api/system/health",
        "/api/system/stats",
        "/dashboard/health",
    ],
};
