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
 * ```
 */
import path from "node:path";
import { z } from "zod";
import { logger, SENSITIVE_KEYS } from "../utils/logger";

// --- Constants & Versioning ---
export const VERSION = "2.3.2";
export const USER_AGENT = `OpenMemory/${VERSION} (Bot; +https://github.com/nullure/openmemory)`;

// --- Environment Detection ---
export const NODE_ENV = Bun.env.NODE_ENV || "development";
export const IS_TEST = NODE_ENV === "test";
export const IS_PROD = NODE_ENV === "production";
export const IS_DEV = NODE_ENV === "development";

// --- Configuration Validation Errors ---
export class ConfigurationError extends Error {
    constructor(
        message: string,
        public readonly field?: string,
        public readonly value?: any,
        public readonly suggestion?: string
    ) {
        super(message);
        this.name = "ConfigurationError";
    }
}

export interface ValidationIssue {
    field: string;
    message: string;
    value?: any;
    suggestion?: string;
    severity: "error" | "warning" | "info";
}

// --- Helpers ---
const getEnv = (key: string): string | undefined => Bun.env[key];

const boolSchema = z.union([z.boolean(), z.string()]).transform((val) => {
    if (typeof val === "boolean") return val;
    const lower = val.toLowerCase();
    return lower === "true" || lower === "1" || lower === "on" || lower === "yes";
});

const strSchema = (def: string) =>
    z.any().transform((v) => (v === undefined || v === null || v === "" ? def : String(v)));

const numSchema = (def: number, min?: number, max?: number) =>
    z.preprocess((v) => {
        if (v === "" || v === null || v === undefined) return undefined;
        const n = Number(v);
        return isNaN(n) ? undefined : n;
    }, z.number().default(def).refine((val) => {
        if (min !== undefined && val < min) return false;
        if (max !== undefined && val > max) return false;
        return true;
    }, {
        message: `Value must be between ${min ?? "any"} and ${max ?? "any"}`
    }));

const urlSchema = (def: string) =>
    z.string().url().optional().or(z.literal("")).default(def);

const portSchema = (def: number) =>
    numSchema(def, IS_TEST ? 0 : 1, 65535).refine((port) => {
        // Check if port is commonly used by other services
        const commonPorts = [22, 23, 25, 53, 80, 110, 143, 443, 993, 995];
        if (commonPorts.includes(port) && !IS_TEST) {
            logger.warn(`⚠️  Port ${port} is commonly used by other services. Consider using a different port.`);
        }
        return true;
    });

// --- Tier Definitions ---
const TierSchema = z.enum(["fast", "smart", "deep", "hybrid"]).default("hybrid");
type Tier = z.infer<typeof TierSchema>;

const tierDims: Record<Tier, number> = { fast: 768, smart: 768, deep: 1024, hybrid: 768 };
const tierCache: Record<Tier, number> = { fast: 2, smart: 5, deep: 10, hybrid: 8 };
const tierMaxActive: Record<Tier, number> = { fast: 32, smart: 64, deep: 128, hybrid: 100 };
const tierVectorCache: Record<Tier, number> = { fast: 128, smart: 512, deep: 1024, hybrid: 512 };

/**
 * Interface for environment configuration.
 */
export interface EnvConfig extends z.infer<ReturnType<typeof createEnvSchema>> {
    isTest: boolean;
    isProd: boolean;
    isDev: boolean;
    nodeEnv: string;
}

/**
 * Environment-specific configuration overrides
 */
const getEnvironmentOverrides = (env: string): Partial<Record<string, any>> => {
    switch (env) {
        case "test":
            return {
                dbPath: ":memory:",
                logLevel: "error",
                telemetryEnabled: false,
                rateLimitEnabled: false,
                encryptionEnabled: false,
                verbose: false,
                autoReflect: false,
                decayIntervalMinutes: 1440, // 24 hours for tests
                embedDelayMs: 0, // No delay in tests
                crawlerDelayMs: 0, // No delay in tests
            };
        case "production":
            return {
                logLevel: "info",
                telemetryEnabled: true,
                rateLimitEnabled: true,
                encryptionEnabled: true,
                verbose: false,
                autoReflect: true,
                noAuth: false,
            };
        case "development":
            return {
                logLevel: "debug",
                telemetryEnabled: false,
                rateLimitEnabled: false,
                verbose: true,
                noAuth: true,
            };
        default:
            return {};
    }
};

/**
 * Validate required environment variables based on configuration
 */
const validateRequiredEnvVars = (config: any): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];

    // Database validation
    if (config.dbPath && config.dbPath !== ":memory:") {
        const dbDir = path.dirname(config.dbPath);
        try {
            // Check if directory exists or can be created
            if (!Bun.file(dbDir).exists) {
                issues.push({
                    field: "dbPath",
                    message: `Database directory does not exist: ${dbDir}`,
                    value: config.dbPath,
                    suggestion: `Create the directory or use a different path. For in-memory database, use ":memory:"`,
                    severity: "error"
                });
            }
        } catch (error) {
            issues.push({
                field: "dbPath",
                message: `Cannot access database path: ${config.dbPath}`,
                value: config.dbPath,
                suggestion: "Check file permissions and path validity",
                severity: "error"
            });
        }
    }

    // Encryption validation
    if (config.encryptionEnabled) {
        if (!config.encryptionKey || config.encryptionKey.length < 32) {
            issues.push({
                field: "encryptionKey",
                message: "Encryption key must be at least 32 characters when encryption is enabled",
                value: config.encryptionKey ? "[REDACTED]" : undefined,
                suggestion: "Set OM_ENCRYPTION_KEY environment variable with a strong key",
                severity: "error"
            });
        }
        if (!config.encryptionSalt || config.encryptionSalt.length < 16) {
            issues.push({
                field: "encryptionSalt",
                message: "Encryption salt must be at least 16 characters when encryption is enabled",
                value: config.encryptionSalt ? "[REDACTED]" : undefined,
                suggestion: "Set OM_ENCRYPTION_SALT environment variable with a random salt",
                severity: "error"
            });
        }
    }

    // API Keys validation for production
    if (IS_PROD && !config.noAuth) {
        if (!config.apiKey && !config.adminKey) {
            issues.push({
                field: "apiKey",
                message: "API key or admin key is required in production",
                suggestion: "Set OM_API_KEY or OM_ADMIN_KEY environment variable",
                severity: "error"
            });
        }
    }

    // External service validation
    if (config.embKind === "openai" && !config.openaiKey) {
        issues.push({
            field: "openaiKey",
            message: "OpenAI API key is required when using OpenAI embeddings",
            suggestion: "Set OM_OPENAI_KEY or OPENAI_API_KEY environment variable",
            severity: "error"
        });
    }

    if (config.embKind === "gemini" && !config.geminiKey) {
        issues.push({
            field: "geminiKey",
            message: "Gemini API key is required when using Gemini embeddings",
            suggestion: "Set OM_GEMINI_KEY or GEMINI_API_KEY environment variable",
            severity: "error"
        });
    }

    if (config.embKind === "anthropic" && !config.anthropicKey) {
        issues.push({
            field: "anthropicKey",
            message: "Anthropic API key is required when using Anthropic embeddings",
            suggestion: "Set OM_ANTHROPIC_KEY or ANTHROPIC_API_KEY environment variable",
            severity: "error"
        });
    }

    // PostgreSQL validation
    if (config.metadataBackend === "postgres" || config.vectorBackend === "postgres") {
        if (!config.pgHost || !config.pgUser || !config.pgDb) {
            issues.push({
                field: "postgres",
                message: "PostgreSQL connection details are incomplete",
                suggestion: "Set OM_PG_HOST, OM_PG_USER, and OM_PG_DB environment variables",
                severity: "error"
            });
        }
    }

    // Redis/Valkey validation
    if (config.lockBackend === "redis") {
        if (!config.valkeyHost) {
            issues.push({
                field: "valkeyHost",
                message: "Redis/Valkey host is required when using Redis lock backend",
                suggestion: "Set OM_VALKEY_HOST environment variable",
                severity: "error"
            });
        }
    }

    // Performance warnings
    if (config.maxActive > 1000) {
        issues.push({
            field: "maxActive",
            message: "Very high maxActive value may impact performance",
            value: config.maxActive,
            suggestion: "Consider reducing maxActive or ensure adequate system resources",
            severity: "warning"
        });
    }

    if (config.vectorCacheSizeMb > 2048) {
        issues.push({
            field: "vectorCacheSizeMb",
            message: "Very high vector cache size may impact memory usage",
            value: config.vectorCacheSizeMb,
            suggestion: "Monitor system memory usage with this configuration",
            severity: "warning"
        });
    }

    return issues;
};

/**
 * Display configuration validation results
 */
const displayValidationResults = (issues: ValidationIssue[]): void => {
    if (issues.length === 0) {
        logger.info("✅ Configuration validation passed");
        return;
    }

    const errors = issues.filter(i => i.severity === "error");
    const warnings = issues.filter(i => i.severity === "warning");
    const infos = issues.filter(i => i.severity === "info");

    if (errors.length > 0) {
        logger.error("❌ Configuration validation failed:");
        errors.forEach(issue => {
            logger.error(`  • ${issue.field}: ${issue.message}`);
            if (issue.suggestion) {
                logger.error(`    💡 ${issue.suggestion}`);
            }
        });
    }

    if (warnings.length > 0) {
        logger.warn("⚠️  Configuration warnings:");
        warnings.forEach(issue => {
            logger.warn(`  • ${issue.field}: ${issue.message}`);
            if (issue.suggestion) {
                logger.warn(`    💡 ${issue.suggestion}`);
            }
        });
    }

    if (infos.length > 0) {
        logger.info("ℹ️  Configuration information:");
        infos.forEach(issue => {
            logger.info(`  • ${issue.field}: ${issue.message}`);
            if (issue.suggestion) {
                logger.info(`    💡 ${issue.suggestion}`);
            }
        });
    }

    if (errors.length > 0) {
        throw new ConfigurationError(
            `Configuration validation failed with ${errors.length} error(s)`,
            errors[0].field,
            errors[0].value,
            errors[0].suggestion
        );
    }
};

// --- Environment Schema Factory ---
const createEnvSchema = (currentTier: Tier) => {
    const baseSchema = z.object({
        // Server
        port: portSchema(8080),
        dbPath: z.preprocess((v) => {
            // Check for explicit environment variable first
            const envDbPath = getEnv("OM_DB_PATH");
            if (envDbPath && envDbPath !== "") return String(envDbPath);
            
            if (v && v !== "") return String(v);
            return IS_TEST
                ? ":memory:"
                : path.resolve(import.meta.dir, "../../data/openmemory.sqlite");
        }, z.string()).default(IS_TEST ? ":memory:" : path.resolve(import.meta.dir, "../../data/openmemory.sqlite")),

        // Keys
        apiKey: z.string().optional().refine((val) => {
            if (IS_PROD && !val && !getEnv("OM_ADMIN_KEY")) {
                return false;
            }
            return true;
        }, {
            message: "API key is required in production environment"
        }),
        adminKey: z.string().optional(),

        // Scaling (Tier-dependent)
        tier: TierSchema.default(currentTier),
        vecDim: numSchema(tierDims[currentTier], 32, 4096),
        cacheSegments: numSchema(tierCache[currentTier], 1, 100),
        maxActive: numSchema(tierMaxActive[currentTier], 1, 10000),
        maxVectorDim: numSchema(tierDims[currentTier], 32, 4096),
        vectorCacheSizeMb: numSchema(tierVectorCache[currentTier], 64, 8192),

        // Operations
        rateLimitEnabled: boolSchema.default(!IS_DEV),
        rateLimitWindowMs: numSchema(60000, 1000, 3600000), // 1 second to 1 hour
        rateLimitMaxRequests: numSchema(100, 1, 10000),
        compressionEnabled: boolSchema.default(false),
        compressionAlgorithm: z.enum(["semantic", "syntactic", "aggressive", "auto"]).default("auto"),
        compressionMinLength: numSchema(100, 10, 10000),

        // Embeddings
        embKind: z.preprocess((v) => {
            if (v) return String(v);
            return getEnv("OM_EMBED_KIND") || getEnv("OM_EMBEDDINGS") || (getEnv("OM_OPENAI_API_KEY") || getEnv("OM_GEMINI_API_KEY") ? "openai" : "local");
        }, z.string()).default("local"),
        embeddingFallback: z.string().default("synthetic").transform(v => v.split(",").map(s => s.trim()).filter(Boolean)),
        embedMode: strSchema("simple"),
        advEmbedParallel: boolSchema.default(false),
        embedDelayMs: numSchema(300, 0, 10000),
        embedTimeoutMs: numSchema(30000, 1000, 300000),

        // External Providers
        openaiKey: z.string().default("").transform(v => v || getEnv("OM_OPENAI_API_KEY") || getEnv("OPENAI_API_KEY") || ""),
        openaiBaseUrl: urlSchema("https://api.openai.com/v1"),
        openaiModel: z.string().default("gpt-4o").transform(v => v || getEnv("OM_OPENAI_MODEL") || "gpt-4o"),
        geminiKey: z.string().default("").transform(v => v || getEnv("OM_GEMINI_API_KEY") || getEnv("GEMINI_API_KEY") || ""),
        geminiBaseUrl: urlSchema("https://generativelanguage.googleapis.com"),
        geminiModel: z.string().default("gemini-1.5-flash").transform(v => v || getEnv("OM_GEMINI_MODEL") || "gemini-1.5-flash"),
        geminiApiVersion: strSchema("v1beta"),
        anthropicKey: z.string().default("").transform(v => v || getEnv("OM_ANTHROPIC_API_KEY") || getEnv("ANTHROPIC_API_KEY") || ""),
        anthropicBaseUrl: urlSchema("https://api.anthropic.com"),
        anthropicModel: z.string().default("claude-3-5-sonnet-latest").transform(v => v || getEnv("OM_ANTHROPIC_MODEL") || "claude-3-5-sonnet-latest"),

        // Infrastructure
        awsRegion: strSchema("us-east-1").transform(v => v || getEnv("AWS_REGION") || "us-east-1"),
        awsAccessKeyId: strSchema(""),
        awsSecretAccessKey: strSchema(""),
        awsModel: strSchema("amazon.titan-embed-text-v2:0"),
        ollamaUrl: z.string().default("http://localhost:11434").transform(v => v || getEnv("OM_OLLAMA_URL") || "http://localhost:11434"),
        ollamaModel: strSchema("llama3.2"),
        ollamaEmbedModel: strSchema("nomic-embed-text"),
        ollamaEmbedModels: z.string().default("").transform(s => {
            if (!s) return {};
            try {
                return JSON.parse(s);
            } catch {
                return {};
            }
        }),
        ollamaTimeout: numSchema(60000, 5000, 600000),
        ollamaNumGpu: numSchema(1, 0, 16),

        // Local Models
        localModelPath: strSchema(""),
        localModel: strSchema(""),
        localEmbeddingModel: strSchema("snowflake-arctic-embed"),
        localEmbeddingResize: boolSchema.default(false),
        localEmbeddingDevice: z.enum(["auto", "cpu", "cuda", "webgpu"]).default("auto"),
        localEmbeddingThreads: numSchema(4, 1, 32),

        // Redis/Valkey
        valkeyHost: strSchema("localhost"),
        valkeyPort: numSchema(6379, 1, 65535),
        valkeyPassword: strSchema(""),

        // Storage & Backend
        metadataBackend: strSchema("sqlite").transform(s => s.toLowerCase()),
        vectorBackend: strSchema("sqlite").transform(s => s.toLowerCase()),
        vectorTable: strSchema("vectors"),
        pgSchema: strSchema("public"),
        pgTable: strSchema("openmemory_memories"),
        pgDb: strSchema("openmemory"),
        pgHost: strSchema("localhost"),
        pgUser: strSchema("postgres"),
        pgPort: numSchema(5432, 1, 65535),
        pgPassword: strSchema(""),
        pgSsl: strSchema("disable"),
        pgMax: numSchema(20, 1, 100),
        pgIdleTimeout: numSchema(30000, 1000, 300000),
        pgConnTimeout: numSchema(2000, 500, 30000),
        usersTable: strSchema("users"),
        lockBackend: z.enum(["auto", "redis", "postgres", "sqlite"]).default("auto"),

        // Security
        encryptionEnabled: boolSchema.default(IS_PROD),
        encryptionKey: z.string().optional(),
        encryptionSalt: strSchema(""),
        encryptionSecondaryKeys: z.string().default("").transform(s => s.split(",").map(k => k.trim()).filter(Boolean)),

        // Logic & Cog
        reinfWaypointBoost: numSchema(0.1, 0, 1),
        hsgCacheTtlMs: numSchema(60000, 1000, 3600000),
        classifierOverrideThreshold: numSchema(0.6, 0, 1),
        minScore: numSchema(0.3, 0, 1),
        decayLambda: numSchema(0.005, 0, 1),
        
        // Sector-specific decay rates
        decayEpisodic: numSchema(0.01, 0, 1),
        decaySemantic: numSchema(0.005, 0, 1),
        decayProcedural: numSchema(0.008, 0, 1),
        decayEmotional: numSchema(0.003, 0, 1),
        decayReflective: numSchema(0.002, 0, 1),
        decaySlow: numSchema(0.001, 0, 1),
        
        // Dynamics Constants
        dynamicsAlpha: numSchema(0.1, 0, 1), // Learning rate for recall reinforcement
        dynamicsBeta: numSchema(0.05, 0, 1), // Learning rate for emotional frequency
        dynamicsGamma: numSchema(0.8, 0, 1), // Attenuation constant for graph distance
        dynamicsTheta: numSchema(0.7, 0, 1), // Consolidation coefficient for long-term
        dynamicsEta: numSchema(0.15, 0, 1), // Reinforcement factor for trace learning
        dynamicsTau: numSchema(0.5, 0, 1), // Energy threshold for retrieval
        decayFast: numSchema(0.02, 0, 1), // Fast decay rate (lambda one)
        
        // Scoring weights
        scoringSimilarity: numSchema(1.0, 0, 10),
        scoringOverlap: numSchema(0.5, 0, 10),
        scoringWaypoint: numSchema(0.3, 0, 10),
        scoringRecency: numSchema(0.2, 0, 10),
        scoringTagMatch: numSchema(0.4, 0, 10),
        scoringSalience: numSchema(0.1, 0, 10),
        scoringKeyword: numSchema(0.05, 0, 10),
        
        // Graph and temporal settings
        graphTemporalWindow: numSchema(86400000, 60000, 604800000), // 1 minute to 1 week
        graphCacheSize: numSchema(1000, 100, 100000),
        
        // LangGraph settings
        lgNamespace: strSchema("default"),
        lgReflective: boolSchema.default(true),
        lgMaxContext: numSchema(2000, 100, 100000),
        
        maxPayloadSize: numSchema(1_000_000, 1000, 100_000_000),
        verbose: boolSchema.default(IS_DEV),
        logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
        telemetryEnabled: boolSchema.default(IS_PROD),
        telemetryEndpoint: urlSchema("https://telemetry.spotit.dev"),
        userAgent: strSchema(USER_AGENT),
        TEST_WORKER_ID: strSchema("0"),
        OM_KEEP_DB: boolSchema.default(false),

        // Auth & IDE
        noAuth: boolSchema.default(IS_DEV),
        logAuth: boolSchema.default(false),
        ideMode: boolSchema.default(false),
        ideAllowedOrigins: z.string().default("").transform(s => s.split(",").map(k => k.trim()).filter(Boolean)),

        // Intervals & Background Tasks
        decayIntervalMinutes: numSchema(60, 1, 10080), // 1 minute to 1 week
        autoReflect: boolSchema.default(!IS_TEST),
        reflectInterval: numSchema(10, 1, 1440), // 1 minute to 24 hours
        reflectClusteringThreshold: numSchema(0.85, 0, 1),
        reflectMin: numSchema(20, 1, 1000),

        // Source Connectors
        githubToken: strSchema(""),
        googleCredentialsJson: strSchema(""),
        googleServiceAccountFile: strSchema(""),
        notionApiKey: strSchema(""),
        azureClientId: strSchema(""),
        azureClientSecret: strSchema(""),
        azureTenantId: strSchema(""),

        // Crawler Settings
        crawlerDelayMs: numSchema(1000, 0, 60000),

        // Event System
        eventMaxListeners: numSchema(100, 10, 1000),

        // Memory & Sector Configuration
        sectorWeights: z.string().default("").transform(s => {
            if (!s) return {};
            try {
                return JSON.parse(s);
            } catch {
                return {};
            }
        }),

        // API Versioning Configuration
        apiVersionConfig: z.string().default("").transform(s => {
            if (!s) return "";
            try {
                // Validate that it's valid JSON
                JSON.parse(s);
                return s;
            } catch {
                return "";
            }
        }),
        defaultApiVersion: strSchema("v1"),
        apiVersionHeaderName: strSchema("X-API-Version"),
        apiVersionDeprecationWarnings: boolSchema.default(true),

        // Keyword Extraction
        keywordMinLength: numSchema(3, 1, 20),

        // Ingestion Settings
        ingestSectionSize: numSchema(2000, 100, 50000),
        ingestLargeThreshold: numSchema(10000, 1000, 1000000),

        // Consolidation & Memory Management
        decayColdThreshold: numSchema(0.3, 0, 1),
        minVectorDim: numSchema(32, 8, 4096),
        summaryLayers: numSchema(3, 1, 10),
        decayRatio: numSchema(0.1, 0.01, 1), // Process 1% to 100% of memories per consolidation cycle
        decaySleepMs: numSchema(100, 0, 10000), // Sleep between segments during consolidation
        regenerationEnabled: boolSchema.default(true),
        decayReinforceOnQuery: boolSchema.default(true),
        maxRetries: numSchema(3, 1, 10),

        // Miscellaneous
        maxImportSize: numSchema(50 * 1024 * 1024, 1024, 1024 * 1024 * 1024), // 1KB to 1GB
        mode: strSchema("persistent"),
    });

    return baseSchema.refine((data) => !data.encryptionEnabled || (data.encryptionKey && data.encryptionKey.length >= 32), {
        message: "encryptionKey must be at least 32 characters when encryptionEnabled is true",
        path: ["encryptionKey"],
    }).refine((data) => !data.encryptionEnabled || (data.encryptionSalt && data.encryptionSalt.length >= 16), {
        message: "encryptionSalt must be at least 16 characters when encryptionEnabled is true",
        path: ["encryptionSalt"],
    });
};

/**
 * Automap env keys (e.g. PORT -> OM_PORT) based on the schema.
 */
const mapEnv = (schemaKeys: string[]): Record<string, string | undefined> => {
    const raw: Record<string, string | undefined> = {};
    for (const key of schemaKeys) {
        // Special case for AWS and common node vars
        if (key === "awsRegion") raw[key] = getEnv("AWS_REGION") || getEnv("OM_AWS_REGION");
        else if (key === "awsAccessKeyId") raw[key] = getEnv("AWS_ACCESS_KEY_ID") || getEnv("OM_AWS_ACCESS_KEY_ID");
        else if (key === "awsSecretAccessKey") raw[key] = getEnv("AWS_SECRET_ACCESS_KEY") || getEnv("OM_AWS_SECRET_ACCESS_KEY");
        else {
            // Map camelCase to SCREAMING_SNAKE_CASE with OM_ prefix
            const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase();
            raw[key] = getEnv(`OM_${snakeKey}`);
        }
    }
    return raw;
};

const parseEnv = (): EnvConfig => {
    const rawTier = getEnv("OM_TIER") || "hybrid";
    const tierResult = TierSchema.safeParse(rawTier);
    const useTier = tierResult.success ? tierResult.data : "hybrid";

    const schema = createEnvSchema(useTier);
    
    // Handle ZodEffects wrapper to get the underlying shape
    let shape: Record<string, z.ZodTypeAny>;
    if ('innerType' in schema && typeof schema.innerType === 'function') {
        const innerType = (schema as any).innerType();
        // The inner type might be another ZodEffects, so we need to unwrap recursively
        let currentType = innerType;
        while ('innerType' in currentType && typeof currentType.innerType === 'function') {
            currentType = (currentType as any).innerType();
        }
        if ('shape' in currentType) {
            shape = (currentType as any).shape;
        } else {
            // Fallback: try to access shape directly
            shape = (currentType as any).shape || {};
        }
    } else if ('shape' in schema) {
        shape = (schema as any).shape;
    } else {
        // Fallback: try to access shape directly
        shape = (schema as any).shape || {};
    }
    
    const rawData = mapEnv(Object.keys(shape));

    // Apply environment-specific overrides
    const envOverrides = getEnvironmentOverrides(NODE_ENV);
    
    // Supplement with non-prefixed or legacy vars that don't fit the mapping perfectly
    const finalRaw = {
        ...rawData,
        ...envOverrides,
        tier: useTier,
    };

    const result = schema.safeParse(finalRaw);
    if (!result.success) {
        logger.error("❌ Configuration Schema Validation Failed:");
        const fmt = result.error.format();
        for (const [key, val] of Object.entries(fmt)) {
            if (key !== "_errors" && !SENSITIVE_KEYS.includes(key)) {
                logger.error(`  • ${key}: ${JSON.stringify(val)}`);
            } else if (key !== "_errors") {
                logger.error(`  • ${key}: [REDACTED]`);
            }
        }
        
        // Provide helpful suggestions for common configuration errors
        logger.error("\n💡 Common Configuration Issues:");
        logger.error("  • Check environment variable names (use OM_ prefix)");
        logger.error("  • Verify numeric values are within valid ranges");
        logger.error("  • Ensure required API keys are set for external services");
        logger.error("  • Validate URL formats for external endpoints");
        
        process.exit(1);
    }

    const config = {
        ...result.data,
        isTest: IS_TEST,
        isProd: IS_PROD,
        isDev: IS_DEV,
        nodeEnv: NODE_ENV,
    };

    // Run additional validation
    try {
        const validationIssues = validateRequiredEnvVars(config);
        displayValidationResults(validationIssues);
    } catch (error) {
        if (error instanceof ConfigurationError) {
            logger.error(`❌ ${error.message}`);
            if (error.suggestion) {
                logger.error(`💡 ${error.suggestion}`);
            }
            process.exit(1);
        }
        throw error;
    }

    // Log configuration summary (non-sensitive info only)
    if (!IS_TEST) {
        logger.info(`🔧 OpenMemory Configuration Loaded:`);
        logger.info(`  • Environment: ${NODE_ENV}`);
        logger.info(`  • Tier: ${config.tier}`);
        logger.info(`  • Port: ${config.port}`);
        logger.info(`  • Database: ${config.dbPath === ":memory:" ? "In-Memory" : "File-based"}`);
        logger.info(`  • Embeddings: ${config.embKind}`);
        logger.info(`  • Encryption: ${config.encryptionEnabled ? "Enabled" : "Disabled"}`);
        logger.info(`  • Rate Limiting: ${config.rateLimitEnabled ? "Enabled" : "Disabled"}`);
        logger.info(`  • Authentication: ${config.noAuth ? "Disabled" : "Enabled"}`);
    }

    return config;
};

/**
 * Validated and typed environment configuration object.
 */
export const env: EnvConfig = parseEnv();

/**
 * Legacy tier export for back-compat.
 * @deprecated Use env.tier
 */
export const tier = () => env.tier;

/**
 * Reloads configuration from environment.
 */
export const reloadConfig = (): EnvConfig => {
    Object.assign(env, parseEnv());
    return env;
};

/**
 * Validate a specific configuration field
 */
export const validateConfigField = (field: string, value: any): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    
    // Add field-specific validation logic here
    switch (field) {
        case "port":
            if (value < 1 || value > 65535) {
                issues.push({
                    field,
                    message: "Port must be between 1 and 65535",
                    value,
                    suggestion: "Use a valid port number (e.g., 8080)",
                    severity: "error"
                });
            }
            break;
        case "encryptionKey":
            if (value && value.length < 32) {
                issues.push({
                    field,
                    message: "Encryption key must be at least 32 characters",
                    value: "[REDACTED]",
                    suggestion: "Generate a strong encryption key with at least 32 characters",
                    severity: "error"
                });
            }
            break;
        // Add more field validations as needed
    }
    
    return issues;
};

/**
 * Get configuration help for a specific field
 */
export const getConfigHelp = (field: string): string => {
    const helpText: Record<string, string> = {
        port: "Server port number (1-65535). Default: 8080",
        dbPath: "Database file path or ':memory:' for in-memory database",
        tier: "Performance tier: fast, smart, deep, or hybrid",
        embKind: "Embedding provider: local, openai, gemini, anthropic, or ollama",
        encryptionEnabled: "Enable data encryption at rest (recommended for production)",
        rateLimitEnabled: "Enable API rate limiting (recommended for production)",
        // Add more help text as needed
    };
    
    return helpText[field] || `No help available for field: ${field}`;
};

/**
 * Export configuration validation utilities
 */
export {
    validateRequiredEnvVars,
    displayValidationResults,
    getEnvironmentOverrides,
};
