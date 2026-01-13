/**
 * @file Configuration management for OpenMemory.
 * Provides typed environment variable parsing with Zod validation.
 * All configuration is accessed via the exported `env` object.
 *
 * Environment Variable Prefix: `OM_`
 *
 * @example
 * ```ts
 * import { env } from './cfg';
 * console.log(env.port); // 8080
 * console.log(env.dbPath); // './data/openmemory.sqlite'
 * ```
 */
import path from "node:path";

import { z } from "zod";

import { logger } from "../utils/logger";

// --- Tier Logic ---
const TierSchema = z
    .enum(["fast", "smart", "deep", "hybrid"])
    .default("hybrid");
const rawTier = process.env.OM_TIER;
const tierResult = TierSchema.safeParse(rawTier);
if (!tierResult.success) {
    if (rawTier)
        logger.warn(
            `[OpenMemory] Invalid OM_TIER "${rawTier}". Defaulting to "hybrid".`,
        );
    else
        logger.warn(
            "[OpenMemory] OM_TIER not set! Please set OM_TIER=hybrid|fast|smart|deep in .env",
        );
}
export const tier = tierResult.success ? tierResult.data : "hybrid";

const tierDims = { fast: 768, smart: 768, deep: 1024, hybrid: 768 }; // Optimized for Nomic/GTE (768) and BGE-M3 (1024)
const tierCache = { fast: 2, smart: 3, deep: 5, hybrid: 3 };
const tierMaxActive = { fast: 32, smart: 64, deep: 128, hybrid: 64 };

// --- Helpers ---
const boolSchema = z.union([z.boolean(), z.string()]).transform((val) => {
    if (typeof val === "boolean") return val;
    return val.toLowerCase() === "true" || val === "1";
});

export const USER_AGENT = "OpenMemory/2.3.0";

const strSchema = (def: string) =>
    z
        .any()
        .transform((v) =>
            v === undefined || v === null || v === "" ? def : String(v),
        );
const numSchema = (def: number) =>
    z.preprocess((v) => {
        if (v === "" || v === null || v === undefined) return undefined;
        const n = Number(v);
        return isNaN(n) ? undefined : n;
    }, z.number().default(def));

const urlSchema = (def: string) =>
    z.string().url().optional().or(z.literal("")).default(def);

// --- Environment Schema ---
const EnvSchema = z.object({
    port: numSchema(8080),
    dbPath: z
        .preprocess(
            (v) =>
                v === undefined || v === null || v === ""
                    ? process.env.NODE_ENV === "test"
                        ? ":memory:"
                        : path.resolve(
                            __dirname,
                            "../../data/openmemory.sqlite",
                        )
                    : String(v),
            z.string(),
        )
        .default(
            process.env.NODE_ENV === "test"
                ? ":memory:"
                : path.resolve(__dirname, "../../data/openmemory.sqlite"),
        ),
    apiKey: z.string().optional(),
    adminKey: z.string().optional(),
    usersTable: strSchema("users"),
    rateLimitEnabled: boolSchema.default(false),
    rateLimitWindowMs: numSchema(60000),
    rateLimitMaxRequests: numSchema(100),
    compressionEnabled: boolSchema.default(false),
    compressionAlgorithm: z
        .enum(["semantic", "syntactic", "aggressive", "auto"])
        .default("auto"),
    compressionMinLength: numSchema(100),
    embKind: z
        .preprocess((v) => {
            if (v) return String(v);
            // Better dynamic default: if no keys but env says OpenAI/Gemini, it will fail anyway.
            // But if nothing is specified, 'local' is safer and more capable than 'synthetic'.
            return process.env.OM_OPENAI_API_KEY ||
                process.env.OM_GEMINI_API_KEY
                ? "openai"
                : "local";
        }, z.string())
        .default("local"),
    embeddingFallback: z
        .string()
        .default("synthetic")
        .transform((val) =>
            val
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
        ),
    embedMode: strSchema("simple"),
    advEmbedParallel: boolSchema.default(false),
    embedDelayMs: numSchema(300), // CPU-Bound: Increase delay to 300ms
    embedTimeoutMs: numSchema(30000),
    openaiKey: z
        .string()
        .default("")
        .or(z.undefined())
        .transform((v) => v || process.env.OM_OPENAI_API_KEY || ""),
    openaiBaseUrl: urlSchema("https://api.openai.com/v1"),
    openaiModel: z
        .string()
        .default("gpt-5.2")
        .transform(
            (v) =>
                v ||
                process.env.OM_OPENAI_MODEL ||
                process.env.OPENAI_MODEL ||
                "gpt-5.2",
        ),
    geminiKey: z
        .string()
        .default("")
        .or(z.undefined())
        .transform((v) => v || process.env.OM_GEMINI_API_KEY || ""),
    geminiBaseUrl: urlSchema("https://generativelanguage.googleapis.com"),
    geminiModel: z
        .string()
        .default("gemini-3.0-flash")
        .transform(
            (v) => v || process.env.OM_GEMINI_MODEL || "gemini-3.0-flash",
        ),
    geminiApiVersion: strSchema("v1beta"), // Default to v1beta, supports v1/v1alpha for Gemini 3+
    anthropicKey: z
        .string()
        .default("")
        .or(z.undefined())
        .transform((v) => v || process.env.OM_ANTHROPIC_API_KEY || ""),
    anthropicBaseUrl: urlSchema("https://api.anthropic.com"),
    anthropicModel: z
        .string()
        .default("claude-4.5-sonnet")
        .transform(
            (v) =>
                v ||
                process.env.OM_ANTHROPIC_MODEL ||
                process.env.ANTHROPIC_MODEL ||
                "claude-4.5-sonnet",
        ),
    awsRegion: z
        .string()
        .optional()
        .transform((v) => v || process.env.AWS_REGION || "us-east-1"),
    awsAccessKeyId: strSchema(""),
    awsSecretAccessKey: strSchema(""),
    ollamaUrl: z
        .string()
        .default("http://localhost:11434")
        .or(z.undefined())
        .transform(
            (v) =>
                v ||
                process.env.OLLAMA_URL ||
                process.env.OLLAMA_HOST ||
                "http://localhost:11434",
        ),
    localModelPath: z
        .string()
        .default("")
        .or(z.undefined())
        .transform((v) => v || process.env.OM_LOCAL_MODEL_PATH || ""),
    // Local-First: defaults to snowflake-arctic-embed (High Performance)
    localEmbeddingModel: strSchema("snowflake-arctic-embed"),
    localEmbeddingResize: boolSchema.default(false), // CPU-Bound: Disable resize (native 768)
    localEmbeddingDevice: z.enum(["auto", "cpu", "cuda", "webgpu"]).default("auto"),
    localEmbeddingThreads: numSchema(4),

    vecDim: numSchema(tierDims[tier]),
    minScore: numSchema(0.3),
    decayLambda: numSchema(0.02),
    decayIntervalMinutes: numSchema(1440),
    maxPayloadSize: numSchema(1_000_000),
    mode: strSchema("standard").transform((s) => s.toLowerCase()),
    lgNamespace: strSchema("default"),
    lgMaxContext: numSchema(50),
    lgReflective: boolSchema.default(true),
    metadataBackend: strSchema("sqlite").transform((s) => s.toLowerCase()),
    vectorBackend: strSchema("sqlite").transform((s) => s.toLowerCase()),
    vectorTable: z
        .string()
        .default("vectors")
        .or(z.undefined())
        .transform((v) => v || process.env.OM_VECTOR_TABLE || "vectors"),
    valkeyHost: strSchema("localhost"),
    valkeyPort: numSchema(6379),
    valkeyPassword: z.string().optional(),
    lockBackend: z
        .enum(["auto", "redis", "postgres", "sqlite"])
        .default("auto"),
    ideMode: boolSchema.default(false),
    ideAllowedOrigins: z
        .string()
        .default("http://localhost:5173,http://localhost:3000")
        .transform((s) => s.split(",")),
    autoReflect: boolSchema.default(false),
    reflectInterval: numSchema(10),
    reflectMin: numSchema(20),
    userSummaryInterval: numSchema(30),
    useSummaryOnly: boolSchema.default(true),
    summaryMaxLength: numSchema(200),
    segSize: numSchema(10000),
    cacheSegments: numSchema(tierCache[tier]),
    maxActive: numSchema(tierMaxActive[tier]),
    decayRatio: numSchema(0.03),
    decaySleepMs: numSchema(200),
    decayThreads: numSchema(3),
    decayColdThreshold: numSchema(0.25),
    decayReinforceOnQuery: boolSchema.default(true),
    regenerationEnabled: boolSchema.default(true),
    maxVectorDim: numSchema(tierDims[tier]),
    minVectorDim: numSchema(64),
    summaryLayers: numSchema(3),
    keywordBoost: numSchema(2.5),
    keywordMinLength: numSchema(3),
    verbose: boolSchema.default(false),
    logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
    classifierTrainInterval: numSchema(360),
    telemetryEnabled: boolSchema.default(true),
    /** Ollama Request Timeout (ms) */
    ollamaTimeout: z.coerce.number().default(60000),
    ollamaModel: z
        .string()
        .default("llama3.2")
        .transform((v) => v || process.env.OM_OLLAMA_MODEL || "llama3.2"),
    ollamaEmbedModels: z
        .string()
        .default("{}")
        .transform((v) => {
            try {
                return JSON.parse(v || process.env.OM_OLLAMA_EMBED_MODELS || "{}");
            } catch {
                return {};
            }
        }),
    ollamaNumGpu: numSchema(1), // Default to 1 if not specified
    crawlerDelayMs: numSchema(1000),
    awsModel: z.string().optional(),
    localModel: z.string().optional(),
    encryptionEnabled: boolSchema.default(false),
    encryptionKey: z.string().optional(),
    encryptionSecondaryKeys: z
        .string()
        .default("")
        .transform((s) =>
            s
                .split(",")
                .map((k) => k.trim())
                .filter(Boolean),
        ),
    encryptionSalt: strSchema("openmemory-salt-v1"),
    telemetryEndpoint: urlSchema("https://telemetry.spotit.dev"),
    ingestSectionSize: numSchema(4000),
    ingestLargeThreshold: numSchema(12000),
    logAuth: boolSchema.default(false),
    noAuth: boolSchema.default(false),

    // Connectors
    azureClientId: z
        .string()
        .optional()
        .or(z.undefined())
        .transform((v) => v || process.env.AZURE_CLIENT_ID || ""),
    azureClientSecret: z
        .string()
        .optional()
        .or(z.undefined())
        .transform((v) => v || process.env.AZURE_CLIENT_SECRET || ""),
    azureTenantId: z
        .string()
        .optional()
        .or(z.undefined())
        .transform((v) => v || process.env.AZURE_TENANT_ID || ""),
    notionApiKey: z
        .string()
        .optional()
        .or(z.undefined())
        .transform((v) => v || process.env.NOTION_API_KEY || ""),
    githubToken: z
        .string()
        .optional()
        .or(z.undefined())
        .transform((v) => v || process.env.GITHUB_TOKEN || ""),
    googleCredentialsJson: z
        .string()
        .optional()
        .or(z.undefined())
        .transform((v) => v || process.env.GOOGLE_CREDENTIALS_JSON || ""),
    googleServiceAccountFile: z
        .string()
        .optional()
        .or(z.undefined())
        .transform((v) => v || process.env.GOOGLE_SERVICE_ACCOUNT_FILE || ""),

    // Explicitly include tier
    tier: z.literal(tier),

    // HSG Scoring
    scoringSimilarity: numSchema(0.35),
    scoringOverlap: numSchema(0.2),
    scoringWaypoint: numSchema(0.15),
    scoringRecency: numSchema(0.1),
    scoringTagMatch: numSchema(0.2),

    // HSG Reinforcement
    reinfSalienceBoost: numSchema(0.1),
    reinfWaypointBoost: numSchema(0.05),
    reinfMaxSalience: numSchema(1.0),
    reinfMaxWaypointWeight: numSchema(1.0),
    reinfPruneThreshold: numSchema(0.05),

    // Decay Lambdas
    decayEpisodic: numSchema(0.015),
    decaySemantic: numSchema(0.005),
    decayProcedural: numSchema(0.008),
    decayEmotional: numSchema(0.02),
    decayReflective: numSchema(0.001),

    // Additional
    graphTemporalWindow: numSchema(30 * 24 * 60 * 60 * 1000),
    graphCacheSize: numSchema(10000),
    pgSchema: strSchema("public"),
    pgTable: strSchema("openmemory_memories"),
    pgDb: strSchema("openmemory"),
    pgHost: strSchema("localhost"),
    pgPort: numSchema(5432),
    pgUser: strSchema("postgres"),
    pgPassword: strSchema(""),
    pgSsl: strSchema("disable"),
    pgMax: numSchema(20),
    pgIdleTimeout: numSchema(30000),
    pgConnTimeout: numSchema(2000),
    maxRetries: numSchema(3),
    cbFailureThreshold: numSchema(5),
    cbResetTimeout: numSchema(30000),
    hsgCacheTtlMs: numSchema(60_000),
}).refine((data) => !data.encryptionEnabled || (data.encryptionKey && data.encryptionKey.length > 0), {
    message: "encryptionKey is required when encryptionEnabled is true",
    path: ["encryptionKey"],
});

const parseEnv = () => {
    const rawEnv = {
        port: process.env.OM_PORT,
        dbPath: process.env.OM_DB_PATH,
        apiKey: process.env.OM_API_KEY,
        adminKey: process.env.OM_ADMIN_KEY,
        usersTable: process.env.OM_USERS_TABLE,
        rateLimitEnabled: process.env.OM_RATE_LIMIT_ENABLED,
        rateLimitWindowMs: process.env.OM_RATE_LIMIT_WINDOW_MS,
        rateLimitMaxRequests: process.env.OM_RATE_LIMIT_MAX_REQUESTS,
        compressionEnabled: process.env.OM_COMPRESSION_ENABLED,
        compressionAlgorithm: process.env.OM_COMPRESSION_ALGORITHM,
        compressionMinLength: process.env.OM_COMPRESSION_MIN_LENGTH,
        embKind: process.env.OM_EMBEDDINGS,
        embeddingFallback: process.env.OM_EMBEDDING_FALLBACK,
        embedMode: process.env.OM_EMBED_MODE,
        advEmbedParallel: process.env.OM_ADV_EMBED_PARALLEL,
        embedDelayMs: process.env.OM_EMBED_DELAY_MS,
        embedTimeoutMs: process.env.OM_EMBED_TIMEOUT_MS,
        openaiKey: process.env.OM_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
        openaiBaseUrl: process.env.OM_OPENAI_BASE_URL,
        openaiModel: process.env.OM_OPENAI_MODEL || process.env.OPENAI_MODEL,
        geminiKey: process.env.OM_GEMINI_API_KEY || process.env.GEMINI_API_KEY,
        geminiBaseUrl: process.env.OM_GEMINI_BASE_URL,
        geminiModel: process.env.OM_GEMINI_MODEL,
        geminiApiVersion: process.env.OM_GEMINI_API_VERSION,
        anthropicKey:
            process.env.OM_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
        anthropicBaseUrl: process.env.OM_ANTHROPIC_BASE_URL,
        anthropicModel:
            process.env.OM_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL,
        awsRegion: process.env.AWS_REGION,
        awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ollamaUrl: process.env.OLLAMA_URL,
        localModelPath: process.env.LOCAL_MODEL_PATH,
        localEmbeddingModel: process.env.OM_LOCAL_EMBEDDING_MODEL,
        localEmbeddingResize: process.env.OM_LOCAL_EMBEDDING_RESIZE,
        localEmbeddingDevice: process.env.OM_LOCAL_EMBEDDING_DEVICE,
        localEmbeddingThreads: process.env.OM_LOCAL_EMBEDDING_THREADS,
        vecDim: process.env.OM_VEC_DIM,
        minScore: process.env.OM_MIN_SCORE,
        decayLambda: process.env.OM_DECAY_LAMBDA,
        decayIntervalMinutes: process.env.OM_DECAY_INTERVAL_MINUTES,
        maxPayloadSize: process.env.OM_MAX_PAYLOAD_SIZE,
        mode: process.env.OM_MODE,
        lgNamespace: process.env.OM_LG_NAMESPACE,
        lgMaxContext: process.env.OM_LG_MAX_CONTEXT,
        lgReflective: process.env.OM_LG_REFLECTIVE,
        metadataBackend: process.env.OM_METADATA_BACKEND,
        vectorBackend: process.env.OM_VECTOR_BACKEND,
        valkeyHost: process.env.OM_VALKEY_HOST,
        valkeyPort: process.env.OM_VALKEY_PORT,
        valkeyPassword: process.env.OM_VALKEY_PASSWORD,
        lockBackend: process.env.OM_LOCK_BACKEND,
        ideMode: process.env.OM_IDE_MODE,
        ideAllowedOrigins: process.env.OM_IDE_ALLOWED_ORIGINS,
        autoReflect: process.env.OM_AUTO_REFLECT,
        reflectInterval: process.env.OM_REFLECT_INTERVAL,
        reflectMin: process.env.OM_REFLECT_MIN_MEMORIES,
        userSummaryInterval: process.env.OM_USER_SUMMARY_INTERVAL,
        useSummaryOnly: process.env.OM_USE_SUMMARY_ONLY,
        summaryMaxLength: process.env.OM_SUMMARY_MAX_LENGTH,
        segSize: process.env.OM_SEG_SIZE,
        cacheSegments: process.env.OM_CACHE_SEGMENTS,
        maxActive: process.env.OM_MAX_ACTIVE,
        decayRatio: process.env.OM_DECAY_RATIO,
        decaySleepMs: process.env.OM_DECAY_SLEEP_MS,
        decayThreads: process.env.OM_DECAY_THREADS,
        decayColdThreshold: process.env.OM_DECAY_COLD_THRESHOLD,
        decayReinforceOnQuery: process.env.OM_DECAY_REINFORCE_ON_QUERY,
        regenerationEnabled: process.env.OM_REGENERATION_ENABLED,
        maxVectorDim: process.env.OM_MAX_VECTOR_DIM,
        minVectorDim: process.env.OM_MIN_VECTOR_DIM,
        summaryLayers: process.env.OM_SUMMARY_LAYERS,
        keywordBoost: process.env.OM_KEYWORD_BOOST,
        keywordMinLength: process.env.OM_KEYWORD_MIN_LENGTH,
        verbose: process.env.OM_VERBOSE,
        logLevel: process.env.OM_LOG_LEVEL,
        classifierTrainInterval: process.env.OM_CLASSIFIER_TRAIN_INTERVAL,
        telemetryEnabled: process.env.OM_TELEMETRY,
        ollamaModel: process.env.OM_OLLAMA_MODEL,
        ollamaEmbedModels: process.env.OM_OLLAMA_EMBED_MODELS,
        ollamaNumGpu: process.env.OM_OLLAMA_NUM_GPU,
        crawlerDelayMs: process.env.OM_CRAWLER_DELAY_MS,
        awsModel: process.env.OM_AWS_MODEL || process.env.AWS_MODEL,
        localModel: process.env.OM_LOCAL_MODEL || process.env.LOCAL_MODEL,
        encryptionEnabled: process.env.OM_ENCRYPTION_ENABLED,
        encryptionKey: process.env.OM_ENCRYPTION_KEY,
        encryptionSecondaryKeys: process.env.OM_ENCRYPTION_SECONDARY_KEYS,
        encryptionSalt: process.env.OM_ENCRYPTION_SALT,
        logAuth: process.env.OM_LOG_AUTH,
        noAuth: process.env.OM_NO_AUTH,
        telemetryEndpoint: process.env.OM_TELEMETRY_ENDPOINT,
        ingestSectionSize: process.env.OM_INGEST_SECTION_SIZE,
        ingestLargeThreshold: process.env.OM_INGEST_LARGE_THRESHOLD,

        tier: tier,

        // Connectors
        azureClientId: process.env.AZURE_CLIENT_ID,
        azureClientSecret: process.env.AZURE_CLIENT_SECRET,
        azureTenantId: process.env.AZURE_TENANT_ID,
        notionApiKey: process.env.NOTION_API_KEY,
        githubToken: process.env.GITHUB_TOKEN,
        googleCredentialsJson: process.env.GOOGLE_CREDENTIALS_JSON,
        googleServiceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,

        scoringSimilarity: process.env.OM_SCORING_SIMILARITY,
        scoringOverlap: process.env.OM_SCORING_OVERLAP,
        scoringWaypoint: process.env.OM_SCORING_WAYPOINT,
        scoringRecency: process.env.OM_SCORING_RECENCY,
        scoringTagMatch: process.env.OM_SCORING_TAG_MATCH,

        reinfSalienceBoost: process.env.OM_REINF_SALIENCE_BOOST,
        reinfWaypointBoost: process.env.OM_REINF_WAYPOINT_BOOST,
        reinfMaxSalience: process.env.OM_REINF_MAX_SALIENCE,
        reinfMaxWaypointWeight: process.env.OM_REINF_MAX_WAYPOINT_WEIGHT,
        reinfPruneThreshold: process.env.OM_REINF_PRUNE_THRESHOLD,

        decayEpisodic: process.env.OM_DECAY_EPISODIC,
        decaySemantic: process.env.OM_DECAY_SEMANTIC,
        decayProcedural: process.env.OM_DECAY_PROCEDURAL,
        decayEmotional: process.env.OM_DECAY_EMOTIONAL,
        decayReflective: process.env.OM_DECAY_REFLECTIVE,

        graphTemporalWindow: process.env.OM_GRAPH_TEMPORAL_WINDOW,
        graphCacheSize: process.env.OM_GRAPH_CACHE_SIZE,
        ollamaTimeout: process.env.OM_OLLAMA_TIMEOUT,
        vectorTable: process.env.OM_VECTOR_TABLE,
        pgSchema: process.env.OM_PG_SCHEMA,
        pgTable: process.env.OM_PG_TABLE,
        pgDb: process.env.OM_PG_DB,
        pgHost: process.env.OM_PG_HOST,
        pgPort: process.env.OM_PG_PORT,
        pgUser: process.env.OM_PG_USER,
        pgPassword: process.env.OM_PG_PASSWORD,
        pgSsl: process.env.OM_PG_SSL,
        pgMax: process.env.OM_PG_MAX,
        pgIdleTimeout: process.env.OM_PG_IDLE_TIMEOUT,
        pgConnTimeout: process.env.OM_PG_CONN_TIMEOUT,
        maxRetries: process.env.OM_MAX_RETRIES,
        cbFailureThreshold: process.env.OM_CB_FAILURE_THRESHOLD,
        cbResetTimeout: process.env.OM_CB_RESET_TIMEOUT,
        hsgCacheTtlMs: process.env.OM_HSG_CACHE_TTL_MS,
    };

    const _env = EnvSchema.safeParse(rawEnv);
    if (!_env.success) {
        // Mask sensitive keys in error output
        const fmt = _env.error.format();
        logger.error("❌ Invalid Configuration:");
        // Basic safe logging without dumping secrets
        for (const [key, val] of Object.entries(fmt)) {
            if (
                key !== "_errors" &&
                ![
                    "apiKey",
                    "openaiKey",
                    "geminiKey",
                    "anthropicKey",
                    "encryptionKey",
                ].includes(key)
            ) {
                logger.error(`  - ${key}: ${JSON.stringify(val)}`);
            } else if (key !== "_errors") {
                logger.error(`  - ${key}: [REDACTED ERROR]`);
            }
        }
        process.exit(1);
    }
    return {
        ..._env.data,
        isTest: process.env.NODE_ENV === "test",
        isProd: process.env.NODE_ENV === "production",
    };
};

export type EnvConfig = z.infer<typeof EnvSchema> & {
    isTest: boolean;
    isProd: boolean;
};
export const env: EnvConfig = parseEnv();

/**
 * Reloads configuration from process.env.
 * Primarily used for testing dynamic configuration changes.
 */
export const reloadConfig = (): EnvConfig => {
    Object.assign(env, parseEnv());
    return env;
};
