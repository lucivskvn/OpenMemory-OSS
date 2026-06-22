import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const tier_dims = { fast: 1536, smart: 1536, deep: 1536, hybrid: 1536 };
const tier_cache = { fast: 2, smart: 3, deep: 5, hybrid: 3 };
const tier_max_active = { fast: 32, smart: 64, deep: 128, hybrid: 64 };

export const envSchema = z.object({
    port: z.coerce.number().default(8080),
    db_path: z
        .string()
        .default(path.resolve(__dirname, "../../data/openmemory.sqlite")),
    api_key: z.string().optional(),
    rate_limit_enabled: z.preprocess((v) => v === "true", z.boolean()),
    rate_limit_window_ms: z.coerce.number().default(60000),
    rate_limit_max_requests: z.coerce.number().default(100),
    compression_enabled: z.preprocess((v) => v === "true", z.boolean()),
    compression_algorithm: z
        .enum(["semantic", "syntactic", "aggressive", "auto"])
        .default("auto"),
    compression_min_length: z.coerce.number().default(100),
    emb_kind: z.string().default("synthetic"),
    embedding_fallback: z
        .string()
        .default("synthetic")
        .transform((s) =>
            s
                .split(",")
                .map((i) => i.trim())
                .filter(Boolean),
        ),
    embed_mode: z.string().default("simple"),
    adv_embed_parallel: z.preprocess((v) => v === "true", z.boolean()),
    embed_delay_ms: z.coerce.number().default(200),
    openai_key: z
        .string()
        .default("")
        .transform(
            (v, ctx) =>
                v ||
                process.env.OPENAI_API_KEY ||
                process.env.OM_OPENAI_API_KEY ||
                "",
        ),
    openai_base_url: z.string().default("https://api.openai.com/v1"),
    openai_model: z.string().optional(),
    gemini_key: z
        .string()
        .default("")
        .transform(
            (v, ctx) =>
                v ||
                process.env.GEMINI_API_KEY ||
                process.env.OM_GEMINI_API_KEY ||
                "",
        ),
    AWS_REGION: z.string().default(""),
    AWS_ACCESS_KEY_ID: z.string().default(""),
    AWS_SECRET_ACCESS_KEY: z.string().default(""),
    siray_key: z
        .string()
        .default("")
        .transform(
            (v, ctx) =>
                v ||
                process.env.SIRAY_API_TOKEN ||
                process.env.OM_SIRAY_API_TOKEN ||
                "",
        ),
    siray_base_url: z.string().default("https://api.siray.ai/v1"),
    ollama_url: z.string().default("http://localhost:11434"),
    local_model_path: z
        .string()
        .default("")
        .transform(
            (v, ctx) =>
                v ||
                process.env.LOCAL_MODEL_PATH ||
                process.env.OM_LOCAL_MODEL_PATH ||
                "",
        ),
    vec_dim: z.coerce.number().default(256),
    min_score: z.coerce.number().default(0.3),
    decay_lambda: z.coerce.number().default(0.02),
    decay_interval_minutes: z.coerce.number().default(1440),
    max_payload_size: z.coerce.number().default(1_000_000),
    mode: z
        .string()
        .default("standard")
        .transform((v) => v.toLowerCase()),
    lg_namespace: z.string().default("default"),
    lg_max_context: z.coerce.number().default(50),
    lg_reflective: z.preprocess((v) => v !== "false", z.boolean()),
    metadata_backend: z
        .string()
        .default("sqlite")
        .transform((v) => v.toLowerCase()),
    vector_backend: z
        .string()
        .default("postgres")
        .transform((v) => v.toLowerCase()),
    valkey_host: z.string().default("localhost"),
    valkey_port: z.coerce.number().default(6379),
    valkey_password: z.string().optional(),
    ide_mode: z.preprocess((v) => v === "true", z.boolean()),
    ide_allowed_origins: z
        .string()
        .default("http://localhost:5173,http://localhost:3000")
        .transform((s) => s.split(",")),
    auto_reflect: z.preprocess((v) => v === "true", z.boolean()),
    reflect_interval: z.coerce.number().default(10),
    reflect_min: z.coerce.number().default(20),
    user_summary_interval: z.coerce.number().default(30),
    use_summary_only: z.preprocess((v) => v !== "false", z.boolean()),
    summary_max_length: z.coerce.number().default(200),
    seg_size: z.coerce.number().default(10000),
    cache_segments: z.coerce.number().default(3),
    max_active: z.coerce.number().default(64),
    decay_ratio: z.coerce.number().default(0.03),
    decay_sleep_ms: z.coerce.number().default(200),
    decay_threads: z.coerce.number().default(3),
    decay_cold_threshold: z.coerce.number().default(0.25),
    decay_reinforce_on_query: z.preprocess((v) => v !== "false", z.boolean()),
    regeneration_enabled: z.preprocess((v) => v !== "false", z.boolean()),
    max_vector_dim: z.coerce.number().default(256),
    min_vector_dim: z.coerce.number().default(64),
    summary_layers: z.coerce.number().default(3),
    keyword_boost: z.coerce.number().default(2.5),
    keyword_min_length: z.coerce.number().default(3),
    OM_TURSO_URL: z.string().optional(),
    OM_TURSO_TOKEN: z.string().optional(),
    OM_ENCRYPTION_KEY: z.string().optional(),
    OM_CLUSTER_PEERS: z
        .string()
        .optional()
        .transform((v) => (v ? v.split(",").map((s) => s.trim()) : [])),
    OM_NODE_ID: z.string().optional(),
});

const get_tier = (): "fast" | "smart" | "deep" | "hybrid" => {
    const man = process.env.OM_TIER as any;
    if (man && ["fast", "smart", "deep", "hybrid"].includes(man)) return man;
    console.warn(
        "[OpenMemory] OM_TIER not set! Please set OM_TIER=hybrid|fast|smart|deep in .env",
    );
    return "hybrid";
};

export const tier = get_tier();

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
    openai_key: process.env.OM_OPENAI_API_KEY,
    openai_base_url: process.env.OM_OPENAI_BASE_URL,
    openai_model: process.env.OM_OPENAI_MODEL,
    gemini_key: process.env.OM_GEMINI_API_KEY,
    siray_key: process.env.OM_SIRAY_API_TOKEN,
    siray_base_url: process.env.OM_SIRAY_BASE_URL,
    ollama_url: process.env.OLLAMA_URL || process.env.OM_OLLAMA_URL,
    local_model_path:
        process.env.LOCAL_MODEL_PATH || process.env.OM_LOCAL_MODEL_PATH,
    vec_dim: process.env.OM_VEC_DIM || tier_dims[tier],
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
    cache_segments: process.env.OM_CACHE_SEGMENTS || tier_cache[tier],
    max_active: process.env.OM_MAX_ACTIVE || tier_max_active[tier],
    decay_ratio: process.env.OM_DECAY_RATIO,
    decay_sleep_ms: process.env.OM_DECAY_SLEEP_MS,
    decay_threads: process.env.OM_DECAY_THREADS,
    decay_cold_threshold: process.env.OM_DECAY_COLD_THRESHOLD,
    decay_reinforce_on_query: process.env.OM_DECAY_REINFORCE_ON_QUERY,
    regeneration_enabled: process.env.OM_REGENERATION_ENABLED,
    max_vector_dim: process.env.OM_MAX_VECTOR_DIM || tier_dims[tier],
    min_vector_dim: process.env.OM_MIN_VECTOR_DIM,
    summary_layers: process.env.OM_SUMMARY_LAYERS,
    keyword_boost: process.env.OM_KEYWORD_BOOST,
    keyword_min_length: process.env.OM_KEYWORD_MIN_LENGTH,
    OM_TURSO_URL: process.env.OM_TURSO_URL,
    OM_TURSO_TOKEN: process.env.OM_TURSO_TOKEN,
    OM_ENCRYPTION_KEY: process.env.OM_ENCRYPTION_KEY,
    OM_CLUSTER_PEERS: process.env.OM_CLUSTER_PEERS,
    OM_NODE_ID: process.env.OM_NODE_ID,
};

export const env = envSchema.parse(rawEnv);
