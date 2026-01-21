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
import os from "node:os"; // Added os import

import { z } from "zod";

import { logger, SENSITIVE_KEYS } from "../utils/logger";

// --- Helpers ---
const getEnv = (key: string): string | undefined => {
    return Bun.env[key];
};

export const VERSION = "2.3.2";
export const USER_AGENT = `OpenMemory/${VERSION}`;

const boolSchema = z.union([z.boolean(), z.string()]).transform((val) => {
    if (typeof val === "boolean") return val;
    return val.toLowerCase() === "true" || val === "1";
});

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

// --- Tier Logic ---
const TierSchema = z
    .enum(["fast", "smart", "deep", "hybrid"])
    .default("hybrid");

const rawTier = getEnv("OM_TIER");
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
// Export initial tier for backward compatibility (static imports)
export const tier = tierResult.success ? tierResult.data : "hybrid";

const tierDims = { fast: 768, smart: 768, deep: 1024, hybrid: 768 }; // Optimized for Nomic/GTE (768) and BGE-M3 (1024)
const tierCache = { fast: 2, smart: 5, deep: 10, hybrid: 8 }; // Boosted hybrid/smart cache for better hit rates
const tierMaxActive = { fast: 32, smart: 64, deep: 128, hybrid: 100 };

// --- Environment Schema Factory ---
const createEnvSchema = (currentTier: z.infer<typeof TierSchema>) => {
    return z.object({
        port: numSchema(8080),
        dbPath: z
            .preprocess(
                (v) =>
                    v === undefined || v === null || v === ""
                        ? Bun.env.NODE_ENV === "test"
                            ? ":memory:"
                            : path.resolve(
                                import.meta.dir,
                                "../../data/openmemory.sqlite",
                            )
                        : String(v),
                z.string(),
            )
            .default(
                Bun.env.NODE_ENV === "test"
                    ? ":memory:"
                    : path.resolve(import.meta.dir, "../../data/openmemory.sqlite"),
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
                return getEnv("OM_EMBED_KIND") ||
                    getEnv("OM_EMBEDDINGS") ||
                    getEnv("OM_OPENAI_API_KEY") ||
                    getEnv("OM_GEMINI_API_KEY")
                    ? (getEnv("OM_EMBED_KIND") || getEnv("OM_EMBEDDINGS") || "openai")
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
            .transform((v) => v || getEnv("OM_OPENAI_API_KEY") || ""),
        openaiBaseUrl: urlSchema("https://api.openai.com/v1"),
        openaiModel: z
            .string()
            .default("gpt-4o")
            .transform(
                (v) =>
                    v ||
                    getEnv("OM_OPENAI_MODEL") ||
                    getEnv("OPENAI_MODEL") ||
                    "gpt-4o",
            ),
        geminiKey: z
            .string()
            .default("")
            .or(z.undefined())
            .transform((v) => v || getEnv("OM_GEMINI_API_KEY") || ""),
        geminiBaseUrl: urlSchema("https://generativelanguage.googleapis.com"),
        geminiModel: z
            .string()
            .default("gemini-1.5-flash")
            .transform(
                (v) => v || getEnv("OM_GEMINI_MODEL") || "gemini-1.5-flash",
            ),
        geminiApiVersion: strSchema("v1beta"), // Default to v1beta, supports v1/v1alpha for Gemini 3+
        anthropicKey: z
            .string()
            .default("")
            .or(z.undefined())
            .transform((v) => v || getEnv("OM_ANTHROPIC_API_KEY") || ""),
        anthropicBaseUrl: urlSchema("https://api.anthropic.com"),
        anthropicModel: z
            .string()
            .default("claude-3-5-sonnet-latest")
            .transform(
                (v) =>
                    v ||
                    getEnv("OM_ANTHROPIC_MODEL") ||
                    getEnv("ANTHROPIC_MODEL") ||
                    "claude-3-5-sonnet-latest",
            ),
        awsRegion: z
            .string()
            .optional()
            .transform((v) => v || getEnv("AWS_REGION") || "us-east-1"),
        awsAccessKeyId: strSchema(""),
        awsSecretAccessKey: strSchema(""),
        ollamaUrl: z
            .string()
            .default("http://localhost:11434")
            .or(z.undefined())
            .transform(
                (v) =>
                    v ||
                    getEnv("OM_OLLAMA_URL") ||
                    getEnv("OLLAMA_URL") ||
                    getEnv("OLLAMA_HOST") ||
                    "http://localhost:11434",
            ),
        localModelPath: z
            .string()
            .default("")
            .or(z.undefined())
            .transform((v) => v || getEnv("OM_LOCAL_MODEL_PATH") || ""),
        // Local-First: defaults to snowflake-arctic-embed (High Performance)
        localEmbeddingModel: strSchema("snowflake-arctic-embed"),
        localEmbeddingResize: boolSchema.default(false), // CPU-Bound: Disable resize (native 768)
        localEmbeddingDevice: z.enum(["auto", "cpu", "cuda", "webgpu"]).default("auto"),
        localEmbeddingThreads: numSchema(4),

        // Dynamic Tier Deps
        vecDim: numSchema(tierDims[currentTier]),
        cacheSegments: numSchema(tierCache[currentTier]),
        maxActive: numSchema(tierMaxActive[currentTier]),
        maxVectorDim: numSchema(tierDims[currentTier]),

        minScore: numSchema(0.3),
        decayLambda: numSchema(0.005), // Default to slow (semantic) decay
        decayIntervalMinutes: numSchema(1440),
        maxPayloadSize: numSchema(1_000_000),
        maxImportSize: numSchema(50 * 1024 * 1024), // 50MB default for imports
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
            .transform((v) => v || getEnv("OM_VECTOR_TABLE") || "vectors"),
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
        decayRatio: numSchema(0.03),
        decaySleepMs: numSchema(200),
        decayThreads: numSchema(3),
        decayColdThreshold: numSchema(0.25),
        decayReinforceOnQuery: boolSchema.default(true),
        regenerationEnabled: boolSchema.default(true),
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
            .transform((v) => v || getEnv("OM_OLLAMA_MODEL") || "llama3.2"),
        ollamaEmbedModel: z
            .string()
            .default("nomic-embed-text")
            .transform((v) => v || getEnv("OM_OLLAMA_EMBED_MODEL") || "nomic-embed-text"),
        ollamaEmbedModels: z
            .string()
            .default("{}")
            .transform((v) => {
                try {
                    const parsed = JSON.parse(v || getEnv("OM_OLLAMA_EMBED_MODELS") || "{}");
                    // Validate that it's a Record<string, string>
                    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                        logger.warn("[Config] OM_OLLAMA_EMBED_MODELS must be a JSON object.");
                        return {};
                    }
                    return parsed;
                } catch {
                    logger.warn("[Config] Failed to parse OM_OLLAMA_EMBED_MODELS JSON. Defaulting to {}.");
                    return {};
                }
            })
            .pipe(z.record(z.string(), z.string())),
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
        encryptionSalt: strSchema(""),
        telemetryEndpoint: urlSchema("https://telemetry.spotit.dev"),
        ingestSectionSize: numSchema(4000),
        ingestLargeThreshold: numSchema(12000),
        logAuth: boolSchema.default(false),
        noAuth: boolSchema.default(false),
        vectorCacheSizeMb: numSchema(512), // Default 512MB for vector cache
        trustProxy: boolSchema.default(false),
        eventMaxListeners: numSchema(100),
        userAgent: strSchema("OpenMemory/2.4.0 (Bot; +https://github.com/nullure/openmemory)"),
        OM_KEEP_DB: boolSchema.default(false),
        TEST_WORKER_ID: strSchema("0"),

        // Connectors
        azureClientId: z
            .string()
            .optional()
            .or(z.undefined())
            .transform((v) => v || getEnv("AZURE_CLIENT_ID") || ""),
        azureClientSecret: z
            .string()
            .optional()
            .or(z.undefined())
            .transform((v) => v || getEnv("AZURE_CLIENT_SECRET") || ""),
        azureTenantId: z
            .string()
            .optional()
            .or(z.undefined())
            .transform((v) => v || getEnv("AZURE_TENANT_ID") || ""),
        notionApiKey: z
            .string()
            .optional()
            .or(z.undefined())
            .transform((v) => v || getEnv("NOTION_API_KEY") || ""),
        githubToken: z
            .string()
            .optional()
            .or(z.undefined())
            .transform((v) => v || getEnv("GITHUB_TOKEN") || ""),
        googleCredentialsJson: z
            .string()
            .optional()
            .or(z.undefined())
            .transform((v) => v || getEnv("GOOGLE_CREDENTIALS_JSON") || ""),
        googleServiceAccountFile: z
            .string()
            .optional()
            .or(z.undefined())
            .transform((v) => v || getEnv("GOOGLE_SERVICE_ACCOUNT_FILE") || ""),

        // Explicitly include tier with validation
        tier: TierSchema.default(currentTier),

        // HSG Scoring
        scoringSimilarity: numSchema(1.0),
        scoringOverlap: numSchema(0.5),
        scoringWaypoint: numSchema(0.3),
        scoringRecency: numSchema(0.2),
        scoringTagMatch: numSchema(0.4),
        scoringSalience: numSchema(0.1),
        scoringKeyword: numSchema(0.05),

        // HSG Reinforcement
        reinfSalienceBoost: numSchema(0.1),
        reinfWaypointBoost: numSchema(0.05),
        reinfMaxSalience: numSchema(1.0),
        reinfMaxWaypointWeight: numSchema(1.0),
        reinfPruneThreshold: numSchema(0.05),

        // HSG Sector Weights (JSON map of sector name -> weight)
        sectorWeights: z
            .string()
            .default("{}")
            .transform((v) => {
                try {
                    return JSON.parse(v || getEnv("OM_SECTOR_WEIGHTS") || "{}");
                } catch {
                    logger.warn("[Config] Failed to parse OM_SECTOR_WEIGHTS JSON. Defaulting to {}.");
                    return {};
                }
            }),

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
        reflectClusteringThreshold: numSchema(0.8),
        classifierOverrideThreshold: numSchema(0.6),

        // Dynamics Coefficients
        dynamicsAlpha: numSchema(0.15), // Recall reinforcement
        dynamicsBeta: numSchema(0.2),  // Emotional boost
        dynamicsGamma: numSchema(0.35), // Graph attenuation
        dynamicsTheta: numSchema(0.4),  // Consolidation coeff
        dynamicsEta: numSchema(0.18),   // Trace reinforcement
        dynamicsTau: numSchema(0.4),   // Energy threshold
        decayFast: numSchema(0.015),    // Lambda 1 (Fast)
        decaySlow: numSchema(0.002),    // Lambda 2 (Slow)
    }).refine((data) => !data.encryptionEnabled || (data.encryptionKey && data.encryptionKey.length > 0), {
        message: "encryptionKey is required when encryptionEnabled is true",
        path: ["encryptionKey"],
    }).refine((data) => !data.encryptionEnabled || (data.encryptionSalt && data.encryptionSalt.length > 0 && data.encryptionSalt !== "openmemory-salt-v1"), {
        message: "encryptionSalt must be a unique non-default value when encryptionEnabled is true",
        path: ["encryptionSalt"],
    }).refine((data) => data.embKind !== "aws" || (!!data.awsAccessKeyId && !!data.awsSecretAccessKey), {
        message: "AWS credentials (awsAccessKeyId, awsSecretAccessKey) are required when embKind is 'aws'",
        path: ["embKind"], // blaming embKind as the trigger
    });
};

const parseEnv = () => {
    const tierVal = getEnv("OM_TIER");
    const tRes = TierSchema.safeParse(tierVal);
    const useTier = tRes.success ? tRes.data : "hybrid";

    const EnvSchema = createEnvSchema(useTier);

    const rawEnv = {
        port: getEnv("OM_PORT"),
        dbPath: getEnv("OM_DB_PATH"),
        apiKey: getEnv("OM_API_KEY"),
        adminKey: getEnv("OM_ADMIN_KEY"),
        usersTable: getEnv("OM_USERS_TABLE"),
        rateLimitEnabled: getEnv("OM_RATE_LIMIT_ENABLED"),
        rateLimitWindowMs: getEnv("OM_RATE_LIMIT_WINDOW_MS"),
        rateLimitMaxRequests: getEnv("OM_RATE_LIMIT_MAX_REQUESTS"),
        compressionEnabled: getEnv("OM_COMPRESSION_ENABLED"),
        compressionMinLength: getEnv("OM_COMPRESSION_MIN_LENGTH"),
        embKind: getEnv("OM_EMBED_KIND") || getEnv("OM_EMBEDDINGS"),
        embeddingFallback: getEnv("OM_EMBEDDING_FALLBACK"),
        embedMode: getEnv("OM_EMBED_MODE"),
        advEmbedParallel: getEnv("OM_ADV_EMBED_PARALLEL"),
        embedDelayMs: getEnv("OM_EMBED_DELAY_MS"),
        embedTimeoutMs: getEnv("OM_EMBED_TIMEOUT_MS"),
        openaiKey: getEnv("OM_OPENAI_API_KEY") || getEnv("OPENAI_API_KEY"),
        openaiBaseUrl: getEnv("OM_OPENAI_BASE_URL"),
        openaiModel: getEnv("OM_OPENAI_MODEL") || getEnv("OPENAI_MODEL"),
        geminiKey: getEnv("OM_GEMINI_API_KEY") || getEnv("GEMINI_API_KEY"),
        geminiBaseUrl: getEnv("OM_GEMINI_BASE_URL"),
        geminiModel: getEnv("OM_GEMINI_MODEL"),
        geminiApiVersion: getEnv("OM_GEMINI_API_VERSION"),
        anthropicKey:
            getEnv("OM_ANTHROPIC_API_KEY") || getEnv("ANTHROPIC_API_KEY"),
        anthropicBaseUrl: getEnv("OM_ANTHROPIC_BASE_URL"),
        anthropicModel:
            getEnv("OM_ANTHROPIC_MODEL") || getEnv("ANTHROPIC_MODEL"),
        awsRegion: getEnv("AWS_REGION"),
        awsAccessKeyId: getEnv("AWS_ACCESS_KEY_ID"),
        awsSecretAccessKey: getEnv("AWS_SECRET_ACCESS_KEY"),
        ollamaUrl: getEnv("OM_OLLAMA_URL") || getEnv("OLLAMA_URL") || getEnv("OLLAMA_HOST"),
        localModelPath: getEnv("OM_LOCAL_MODEL_PATH") || getEnv("LOCAL_MODEL_PATH"),
        localEmbeddingModel: getEnv("OM_LOCAL_EMBEDDING_MODEL"),
        localEmbeddingResize: getEnv("OM_LOCAL_EMBEDDING_RESIZE"),
        localEmbeddingDevice: getEnv("OM_LOCAL_EMBEDDING_DEVICE"),
        localEmbeddingThreads: getEnv("OM_LOCAL_EMBEDDING_THREADS"),
        vecDim: getEnv("OM_VEC_DIM"),
        minScore: getEnv("OM_MIN_SCORE"),
        decayLambda: getEnv("OM_DECAY_LAMBDA"),
        decayIntervalMinutes: getEnv("OM_DECAY_INTERVAL_MINUTES"),
        maxPayloadSize: getEnv("OM_MAX_PAYLOAD_SIZE"),
        maxImportSize: getEnv("OM_MAX_IMPORT_SIZE"),
        mode: getEnv("OM_MODE"),
        lgNamespace: getEnv("OM_LG_NAMESPACE"),
        lgMaxContext: getEnv("OM_LG_MAX_CONTEXT"),
        lgReflective: getEnv("OM_LG_REFLECTIVE"),
        metadataBackend: getEnv("OM_METADATA_BACKEND"),
        vectorBackend: getEnv("OM_VECTOR_BACKEND"),
        valkeyHost: getEnv("OM_VALKEY_HOST"),
        valkeyPort: getEnv("OM_VALKEY_PORT"),
        valkeyPassword: getEnv("OM_VALKEY_PASSWORD"),
        lockBackend: getEnv("OM_LOCK_BACKEND"),
        ideMode: getEnv("OM_IDE_MODE"),
        ideAllowedOrigins: getEnv("OM_IDE_ALLOWED_ORIGINS"),
        autoReflect: getEnv("OM_AUTO_REFLECT"),
        reflectInterval: getEnv("OM_REFLECT_INTERVAL"),
        reflectMin: getEnv("OM_REFLECT_MIN_MEMORIES"),
        userSummaryInterval: getEnv("OM_USER_SUMMARY_INTERVAL"),
        useSummaryOnly: getEnv("OM_USE_SUMMARY_ONLY"),
        summaryMaxLength: getEnv("OM_SUMMARY_MAX_LENGTH"),
        segSize: getEnv("OM_SEG_SIZE"),
        cacheSegments: getEnv("OM_CACHE_SEGMENTS"),
        maxActive: getEnv("OM_MAX_ACTIVE"),
        decayRatio: getEnv("OM_DECAY_RATIO"),
        decaySleepMs: getEnv("OM_DECAY_SLEEP_MS"),
        decayThreads: getEnv("OM_DECAY_THREADS"),
        decayColdThreshold: getEnv("OM_DECAY_COLD_THRESHOLD"),
        decayReinforceOnQuery: getEnv("OM_DECAY_REINFORCE_ON_QUERY"),
        regenerationEnabled: getEnv("OM_REGENERATION_ENABLED"),
        maxVectorDim: getEnv("OM_MAX_VECTOR_DIM"),
        minVectorDim: getEnv("OM_MIN_VECTOR_DIM"),
        summaryLayers: getEnv("OM_SUMMARY_LAYERS"),
        keywordBoost: getEnv("OM_KEYWORD_BOOST"),
        keywordMinLength: getEnv("OM_KEYWORD_MIN_LENGTH"),
        verbose: getEnv("OM_VERBOSE"),
        logLevel: getEnv("OM_LOG_LEVEL"),
        classifierTrainInterval: getEnv("OM_CLASSIFIER_TRAIN_INTERVAL"),
        telemetryEnabled: getEnv("OM_TELEMETRY"),
        ollamaModel: getEnv("OM_OLLAMA_MODEL"),
        ollamaEmbedModel: getEnv("OM_OLLAMA_EMBED_MODEL"),
        ollamaEmbedModels: getEnv("OM_OLLAMA_EMBED_MODELS"),
        ollamaNumGpu: getEnv("OM_OLLAMA_NUM_GPU"),
        crawlerDelayMs: getEnv("OM_CRAWLER_DELAY_MS"),
        awsModel: getEnv("OM_AWS_MODEL") || getEnv("AWS_MODEL"),
        localModel: getEnv("OM_LOCAL_MODEL") || getEnv("LOCAL_MODEL"),
        encryptionEnabled: getEnv("OM_ENCRYPTION_ENABLED"),
        encryptionKey: getEnv("OM_ENCRYPTION_KEY"),
        encryptionSecondaryKeys: getEnv("OM_ENCRYPTION_SECONDARY_KEYS"),
        encryptionSalt: getEnv("OM_ENCRYPTION_SALT"),
        logAuth: getEnv("OM_LOG_AUTH"),
        noAuth: getEnv("OM_NO_AUTH"),
        telemetryEndpoint: getEnv("OM_TELEMETRY_ENDPOINT"),
        ingestSectionSize: getEnv("OM_INGEST_SECTION_SIZE"),
        ingestLargeThreshold: getEnv("OM_INGEST_LARGE_THRESHOLD"),
        vectorCacheSizeMb: getEnv("OM_VECTOR_CACHE_SIZE_MB"),
        trustProxy: getEnv("OM_TRUST_PROXY"),
        eventMaxListeners: getEnv("OM_EVENT_MAX_LISTENERS"),
        userAgent: getEnv("OM_USER_AGENT"),
        OM_KEEP_DB: getEnv("OM_KEEP_DB"),
        TEST_WORKER_ID: getEnv("TEST_WORKER_ID"),

        tier: useTier,

        // Connectors
        azureClientId: getEnv("AZURE_CLIENT_ID"),
        azureClientSecret: getEnv("AZURE_CLIENT_SECRET"),
        azureTenantId: getEnv("AZURE_TENANT_ID"),
        notionApiKey: getEnv("NOTION_API_KEY"),
        githubToken: getEnv("GITHUB_TOKEN"),
        googleCredentialsJson: getEnv("GOOGLE_CREDENTIALS_JSON"),
        googleServiceAccountFile: getEnv("GOOGLE_SERVICE_ACCOUNT_FILE"),

        scoringSimilarity: getEnv("OM_SCORING_SIMILARITY"),
        scoringOverlap: getEnv("OM_SCORING_OVERLAP"),
        scoringWaypoint: getEnv("OM_SCORING_WAYPOINT"),
        scoringRecency: getEnv("OM_SCORING_RECENCY"),
        scoringTagMatch: getEnv("OM_SCORING_TAG_MATCH"),
        scoringSalience: getEnv("OM_SCORING_SALIENCE"),
        scoringKeyword: getEnv("OM_SCORING_KEYWORD"),

        reinfSalienceBoost: getEnv("OM_REINF_SALIENCE_BOOST"),
        reinfWaypointBoost: getEnv("OM_REINF_WAYPOINT_BOOST"),
        reinfMaxSalience: getEnv("OM_REINF_MAX_SALIENCE"),
        reinfMaxWaypointWeight: getEnv("OM_REINF_MAX_WAYPOINT_WEIGHT"),
        reinfPruneThreshold: getEnv("OM_REINF_PRUNE_THRESHOLD"),
        sectorWeights: getEnv("OM_SECTOR_WEIGHTS"),

        decayEpisodic: getEnv("OM_DECAY_EPISODIC"),
        decaySemantic: getEnv("OM_DECAY_SEMANTIC"),
        decayProcedural: getEnv("OM_DECAY_PROCEDURAL"),
        decayEmotional: getEnv("OM_DECAY_EMOTIONAL"),
        decayReflective: getEnv("OM_DECAY_REFLECTIVE"),

        graphTemporalWindow: getEnv("OM_GRAPH_TEMPORAL_WINDOW"),
        graphCacheSize: getEnv("OM_GRAPH_CACHE_SIZE"),
        ollamaTimeout: getEnv("OM_OLLAMA_TIMEOUT"),
        vectorTable: getEnv("OM_VECTOR_TABLE"),
        pgSchema: getEnv("OM_PG_SCHEMA"),
        pgTable: getEnv("OM_PG_TABLE"),
        pgDb: getEnv("OM_PG_DB"),
        pgHost: getEnv("OM_PG_HOST"),
        pgPort: getEnv("OM_PG_PORT"),
        pgUser: getEnv("OM_PG_USER"),
        pgPassword: getEnv("OM_PG_PASSWORD"),
        pgSsl: getEnv("OM_PG_SSL"),
        pgMax: getEnv("OM_PG_MAX"),
        pgIdleTimeout: getEnv("OM_PG_IDLE_TIMEOUT"),
        pgConnTimeout: getEnv("OM_PG_CONN_TIMEOUT"),
        maxRetries: getEnv("OM_MAX_RETRIES"),
        cbFailureThreshold: getEnv("OM_CB_FAILURE_THRESHOLD"),
        cbResetTimeout: getEnv("OM_CB_RESET_TIMEOUT"),
        hsgCacheTtlMs: getEnv("OM_HSG_CACHE_TTL_MS"),
        reflectClusteringThreshold: getEnv("OM_REFLECT_CLUSTERING_THRESHOLD"),
        classifierOverrideThreshold: getEnv("OM_CLASSIFIER_OVERRIDE_THRESHOLD"),
        dynamicsAlpha: getEnv("OM_DYNAMICS_ALPHA"),
        dynamicsBeta: getEnv("OM_DYNAMICS_BETA"),
        dynamicsGamma: getEnv("OM_DYNAMICS_GAMMA"),
        dynamicsTheta: getEnv("OM_DYNAMICS_THETA"),
        dynamicsEta: getEnv("OM_DYNAMICS_ETA"),
        dynamicsTau: getEnv("OM_DYNAMICS_TAU"),
        decayFast: getEnv("OM_DECAY_FAST"),
        decaySlow: getEnv("OM_DECAY_SLOW"),
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
                !SENSITIVE_KEYS.includes(key)
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
        isTest: Bun.env.NODE_ENV === "test",
        isProd: Bun.env.NODE_ENV === "production",
    };
};

export type EnvConfig = z.infer<ReturnType<typeof createEnvSchema>> & {
    isTest: boolean;
    isProd: boolean;
};

/**
 * Validated and typed environment configuration object.
 * Access this for all config values.
 */
export const env: EnvConfig = parseEnv();

/**
 * Reloads configuration from Bun.env.
 * Primarily used for testing dynamic configuration changes.
 */
export const reloadConfig = (): EnvConfig => {
    Object.assign(env, parseEnv());
    return env;
};
