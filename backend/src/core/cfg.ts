import { z } from "zod";
import { S3Client } from "@aws-sdk/client-s3";

const envSchema = z.object({
    // Server configuration
    OM_PORT: z.coerce.number().int().positive().default(8080),
    OM_API_KEY: z.string().min(1).optional(),
    OM_MODE: z.enum(["development", "production", "standard", "langgraph"]).default("development"),

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
    // New: Universal Postgres connection string (libpq format). Example:
    // `postgresql://user:password@host:5432/db?sslmode=require`.
    OM_PG_CONNECTION_STRING: z.string().optional(),

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
    OM_ROUTER_CACHE_ENABLED: z.coerce.boolean().default(true),
    OM_ROUTER_FALLBACK_ENABLED: z.coerce.boolean().default(true),
    OM_ROUTER_SIMD_ENABLED: z.coerce.boolean().default(true),
    // Global SIMD enabled controls general SIMD operations across all providers, while OM_ROUTER_SIMD_ENABLED
    // is an optional override specifically for router_cpu embedding operations. Effective SIMD for routing is:
    // router_cpu_effective_simd = OM_ROUTER_SIMD_ENABLED (when set) ?? OM_SIMD_ENABLED (global fallback)
    OM_SIMD_ENABLED: z.coerce.boolean().default(true),
    OM_SIMD_WASM_ENABLED: z.coerce.boolean().default(false), // Experimental: requires custom WASM module
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

    // Universal Auth and JWT/OIDC options
    OM_AUTH_PROVIDER: z.enum(["jwt", "supabase"]).optional(),
    OM_JWT_SECRET: z.string().optional(),
    OM_JWT_ISSUER: z.string().optional(),
    OM_JWT_AUDIENCE: z.string().optional(),

    // Universal S3-compatible bucket configuration (MinIO, Supabase Storage, S3)
    OM_BUCKET_PROVIDER: z.enum(["minio", "supabase", "s3"]).optional(),
    OM_BUCKET_ENDPOINT: z.string().url().optional(),
    OM_BUCKET_ACCESS_KEY: z.string().optional(),
    OM_BUCKET_SECRET_KEY: z.string().optional(),
    OM_BUCKET_REGION: z.string().optional(),
    OM_BUCKET_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
    OM_BUCKET_NAME: z.string().optional(),

    // Rate limiting
    OM_RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
    OM_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    OM_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    OM_ADMIN_API_KEY: z.string().optional(),
    OM_LOG_MIGRATE: z.enum(["true", "false"]).default("false").transform(v => v === "true"),

    // SQLite backup configuration
    OM_BACKUP_DIR: z.string().default("./data/backups"),
    OM_BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
    OM_BACKUP_CLOUD_ENABLED: z.coerce.boolean().default(false),
    OM_BACKUP_AUTO_SCHEDULE: z.coerce.boolean().default(false),
    OM_BACKUP_SCHEDULE_CRON: z.string().default("0 2 * * *"),

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

function parseEnvironment() {
    try {
        return envSchema.parse(process.env);
    } catch (error) {
        console.error("❌ Invalid environment variables:", error);
        process.exit(1);
    }
}

let parsedEnv = parseEnvironment();

// Allow tests to re-parse environment after changing process.env
export function __resetEnvForTests() {
    if (process.env.OM_TEST_MODE !== '1') {
        throw new Error('__resetEnvForTests can only be called in test mode');
    }
    parsedEnv = parseEnvironment();
}

// Validate provider-dependent required values with runtime enforcement
if (parsedEnv.OM_AUTH_PROVIDER === 'jwt' && !parsedEnv.OM_JWT_SECRET) {
    // In production-like modes we normally exit when JWT provider is selected
    // but no secret is configured. Tests set `OM_TEST_MODE` early and rely
    // on being able to toggle OM_MODE for validation — while running tests
    // in parallel this can cause flakiness where a non-mocked import triggers
    // a process exit. To keep tests deterministic we skip the hard exit when
    // OM_TEST_MODE is set.
    const isTestMode = process.env.OM_TEST_MODE === '1';
    if (parsedEnv.OM_MODE !== 'development' && !isTestMode) {
        // See docs/deployment/universal-postgres-auth-bucket.md and SECURITY.md for expected JWT validation behavior
        console.error("[CFG] OM_AUTH_PROVIDER=jwt requires OM_JWT_SECRET; exiting for safety in production mode.");
        process.exit(1);
    } else {
        console.warn("[CFG] OM_AUTH_PROVIDER=jwt is configured but OM_JWT_SECRET is missing; JWT validation will be unavailable (fallback to API-key auth only).");
    }
}
if (parsedEnv.OM_BUCKET_PROVIDER === 's3' && (!parsedEnv.OM_BUCKET_ACCESS_KEY || !parsedEnv.OM_BUCKET_SECRET_KEY)) {
    console.warn("[CFG] OM_BUCKET_PROVIDER=s3 requires OM_BUCKET_ACCESS_KEY and OM_BUCKET_SECRET_KEY (endpoint/region optional for AWS defaults).");
} else if (parsedEnv.OM_BUCKET_PROVIDER && parsedEnv.OM_BUCKET_PROVIDER !== 's3' && (!parsedEnv.OM_BUCKET_ENDPOINT || !parsedEnv.OM_BUCKET_ACCESS_KEY || !parsedEnv.OM_BUCKET_SECRET_KEY)) {
    console.warn(`[CFG] OM_BUCKET_PROVIDER=${parsedEnv.OM_BUCKET_PROVIDER} requires OM_BUCKET_ENDPOINT, OM_BUCKET_ACCESS_KEY and OM_BUCKET_SECRET_KEY for correct operation.`);
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
    router_cache_enabled: parsedEnv.OM_ROUTER_CACHE_ENABLED,
    router_fallback_enabled: parsedEnv.OM_ROUTER_FALLBACK_ENABLED,
    // router_sector_models uses a getter to support test-time environment updates
    get router_sector_models() {
        if (!parsedEnv.OM_ROUTER_SECTOR_MODELS) return null;
        try {
            const parsed = JSON.parse(parsedEnv.OM_ROUTER_SECTOR_MODELS as string);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (error) {
            console.warn(`OM_ROUTER_SECTOR_MODELS contained invalid JSON ("${parsedEnv.OM_ROUTER_SECTOR_MODELS}"), defaulting to null. Error: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    },
    router_dim_tolerance: parsedEnv.OM_ROUTER_DIM_TOLERANCE,
    router_validate_on_start: parsedEnv.OM_ROUTER_VALIDATE_ON_START,
    router_validate_strict: parsedEnv.OM_ROUTER_VALIDATE_STRICT,
    global_simd_enabled: parsedEnv.OM_SIMD_ENABLED,
    // Experimental SIMD WASM feature: requires custom WASM module, defaults to false so startup is not blocked
    simd_wasm_enabled: parsedEnv.OM_SIMD_WASM_ENABLED,

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

    // Backup configuration
    backup_dir: parsedEnv.OM_BACKUP_DIR,
    backup_retention_days: parsedEnv.OM_BACKUP_RETENTION_DAYS,
    backup_cloud_enabled: parsedEnv.OM_BACKUP_CLOUD_ENABLED,
    backup_auto_schedule: parsedEnv.OM_BACKUP_AUTO_SCHEDULE,
    backup_schedule_cron: parsedEnv.OM_BACKUP_SCHEDULE_CRON,

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
    admin_api_key: parsedEnv.OM_ADMIN_API_KEY,
    log_migrate: parsedEnv.OM_LOG_MIGRATE,
    // New env fields for auth and buckets
    pg_connection_string: parsedEnv.OM_PG_CONNECTION_STRING,
    auth_provider: parsedEnv.OM_AUTH_PROVIDER,
    jwt_secret: parsedEnv.OM_JWT_SECRET,
    jwt_issuer: parsedEnv.OM_JWT_ISSUER,
    jwt_audience: parsedEnv.OM_JWT_AUDIENCE,

    bucket_provider: parsedEnv.OM_BUCKET_PROVIDER,
    bucket_endpoint: parsedEnv.OM_BUCKET_ENDPOINT,
    bucket_access_key: parsedEnv.OM_BUCKET_ACCESS_KEY,
    bucket_secret_key: parsedEnv.OM_BUCKET_SECRET_KEY,
    bucket_region: parsedEnv.OM_BUCKET_REGION,
    bucket_force_path_style: parsedEnv.OM_BUCKET_FORCE_PATH_STYLE,
    bucket_name: parsedEnv.OM_BUCKET_NAME,

    // Deprecated or less-used vars kept for compatibility are now read from env schema
};

// Computed flags for downstream consumers (e.g., auth.ts)
export const jwt_enabled = !!(parsedEnv.OM_AUTH_PROVIDER === 'jwt' && parsedEnv.OM_JWT_SECRET);
export const bucket_s3_configured = !!(parsedEnv.OM_BUCKET_PROVIDER === 's3' && parsedEnv.OM_BUCKET_ACCESS_KEY && parsedEnv.OM_BUCKET_SECRET_KEY);

// Removed deprecated fusion_simd_enabled alias - use global_simd_enabled directly

export const tier = process.env.OM_TIER || "hybrid";
export const host = process.env.OM_HOST || "localhost";
export const protocol = env.mode === "development" ? "http" : "https";
export const data_dir = process.env.OM_DATA_DIR || "./data";

// Lazy config reader: re-parse `process.env` at call-time so callers can
// obtain the current environment-derived configuration. Useful for tests
// that modify `process.env` after modules have been imported. This function
// now also exposes backup configuration, including backup_dir, backup_retention_days,
// backup_cloud_enabled, backup_auto_schedule, and backup_schedule_cron, mapping
// from the parsed OM_BACKUP_* fields.
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
        router_cache_enabled: p.OM_ROUTER_CACHE_ENABLED,
        router_fallback_enabled: p.OM_ROUTER_FALLBACK_ENABLED,
        router_sector_models: p.OM_ROUTER_SECTOR_MODELS ? (() => {
            try {
                const parsed = JSON.parse(p.OM_ROUTER_SECTOR_MODELS as string);
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
            } catch (error) {
                console.warn(`OM_ROUTER_SECTOR_MODELS contained invalid JSON ("${p.OM_ROUTER_SECTOR_MODELS}"), defaulting to null. Error: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
        })() : null,
        router_dim_tolerance: p.OM_ROUTER_DIM_TOLERANCE,
        router_validate_on_start: p.OM_ROUTER_VALIDATE_ON_START,
        router_validate_strict: p.OM_ROUTER_VALIDATE_STRICT,
        global_simd_enabled: p.OM_SIMD_ENABLED,
        simd_wasm_enabled: p.OM_SIMD_WASM_ENABLED,

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

        backup_dir: p.OM_BACKUP_DIR,
        backup_retention_days: p.OM_BACKUP_RETENTION_DAYS,
        backup_cloud_enabled: p.OM_BACKUP_CLOUD_ENABLED,
        backup_auto_schedule: p.OM_BACKUP_AUTO_SCHEDULE,
        backup_schedule_cron: p.OM_BACKUP_SCHEDULE_CRON,

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
        admin_api_key: p.OM_ADMIN_API_KEY,
        log_migrate: p.OM_LOG_MIGRATE,
        // New env fields for auth and buckets
        pg_connection_string: p.OM_PG_CONNECTION_STRING,
        auth_provider: p.OM_AUTH_PROVIDER,
        jwt_secret: p.OM_JWT_SECRET,
        jwt_issuer: p.OM_JWT_ISSUER,
        jwt_audience: p.OM_JWT_AUDIENCE,

        bucket_provider: p.OM_BUCKET_PROVIDER,
        bucket_endpoint: p.OM_BUCKET_ENDPOINT,
        bucket_access_key: p.OM_BUCKET_ACCESS_KEY,
        bucket_secret_key: p.OM_BUCKET_SECRET_KEY,
        bucket_region: p.OM_BUCKET_REGION,
        bucket_force_path_style: p.OM_BUCKET_FORCE_PATH_STYLE,
        bucket_name: p.OM_BUCKET_NAME,
    };
}

// Factory function to create S3 client for Supabase Storage or S3-compatible services
export function getS3Client() {
    if (!env.bucket_endpoint || !env.bucket_access_key || !env.bucket_secret_key) {
        throw new Error('Missing required bucket configuration: endpoint, access_key, and secret_key must be set');
    }

    return new S3Client({
        endpoint: env.bucket_endpoint,
        region: env.bucket_region || 'auto', // Supabase doesn't require a specific region
        credentials: {
            accessKeyId: env.bucket_access_key,
            secretAccessKey: env.bucket_secret_key,
        },
        forcePathStyle: env.bucket_force_path_style, // Essential for Supabase Storage
    });
}

// Test seam: allow tests to override admin key at runtime without requiring
// a process restart. This is used by backend tests to set admin_key when
// the server has already been imported and started.
export function setAdminApiKeyForTests(val: string | undefined | null) {
    (env as any).admin_api_key = val as any;
}
