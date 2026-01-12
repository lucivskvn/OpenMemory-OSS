/**
 * @file Model configuration loader for embedding providers.
 * Loads model mappings from models.yml or falls back to sensible defaults.
 */
import { existsSync,readFileSync } from "node:fs"; // Fallback for sync contexts
import { join } from "node:path";

import { parse } from "yaml";

import { logger } from "../utils/logger";
import { env } from "./cfg";

interface ModelCfg {
    [sector: string]: Record<string, string>;
}
let cfg: ModelCfg | null = null;

// Async loader using Bun Native File API (Preferred)
export const loadModelsAsync = async (): Promise<ModelCfg> => {
    if (cfg) return cfg;
    const p = join(__dirname, "../../../models.yml");

    // Check existence asynchronously if possible, or fallback
    const file = Bun.file(p);
    if (!(await file.exists())) {
        logger.warn("[MODELS] models.yml not found, using defaults");
        cfg = getDefaults();
        return cfg!;
    }

    try {
        const yml = await file.text();
        cfg = parseYaml(yml);
        if (env.verbose)
            logger.info(
                `[MODELS] Loaded models.yml (${Object.keys(cfg).length} sectors)`,
            );
        return cfg!;
    } catch (e) {
        logger.error("[MODELS] Failed to parse models.yml (Async):", {
            error: e,
        });
        cfg = getDefaults();
        return cfg!;
    }
};

// Sync loader for legacy/startup interactions (Node Compatibility)
export const loadModelsSync = (): ModelCfg => {
    if (cfg) return cfg;
    const p = join(__dirname, "../../../models.yml");
    if (!existsSync(p)) {
        logger.error("[MODELS] models.yml not found, using defaults");
        cfg = getDefaults(); // Cache default
        return cfg!;
    }
    try {
        const yml = readFileSync(p, "utf-8");
        cfg = parseYaml(yml);

        if (env.verbose)
            logger.info(
                `[MODELS] Loaded models.yml (${Object.keys(cfg).length} sectors)`,
            );
        return cfg!;
    } catch (e) {
        logger.error("[MODELS] Failed to parse models.yml:", { error: e });
        cfg = getDefaults();
        return cfg!;
    }
};



const parseYaml = (yml: string): ModelCfg => {
    try {
        const parsed = parse(yml);
        return (parsed as ModelCfg) || {};
    } catch (e) {
        logger.error("[MODELS] Yaml parse error:", { error: e });
        return {};
    }
};

const getDefaults = (): ModelCfg => ({
    episodic: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "Xenova/nomic-embed-text-v1.5",
    },
    semantic: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "Xenova/nomic-embed-text-v1.5",
    },
    procedural: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "Xenova/nomic-embed-text-v1.5",
    },
    emotional: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "Xenova/nomic-embed-text-v1.5",
    },
    reflective: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-large",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        // BGE-M3 (Apache 2.0): Multi-Lingual, Multi-Granularity, High Perf for Reflective tasks
        local: "Xenova/bge-m3",
    },
});

/**
 * Retrieves the configured model for a given cognitive sector and provider.
 * Respects environment variable overrides (e.g., OM_OPENAI_MODEL) over models.yml.
 * @param sector The cognitive sector (e.g., 'episodic', 'semantic').
 * @param provider The model provider (e.g., 'openai', 'ollama').
 */
export const getModel = (sector: string, provider: string): string => {
    // Environment variable overrides
    if (provider === "ollama" && env.ollamaModel) return env.ollamaModel;
    if (provider === "openai" && env.openaiModel) return env.openaiModel;
    if (provider === "gemini" && env.geminiModel) return env.geminiModel;
    if (provider === "aws" && env.awsModel) return env.awsModel;
    if (provider === "local" && env.localModel) return env.localModel;

    const cfg = loadModelsSync();
    return (
        cfg[sector]?.[provider] ||
        cfg.semantic?.[provider] ||
        "nomic-embed-text"
    );
};

/**
 * Retrieves provider-specific configuration details.
 * Currently a placeholder reserved for future extension (e.g., specific API versions or timeouts).
 * @param _provider The model provider name.
 */
export const getProviderConfig = (
    _provider: string,
): Record<string, unknown> => {
    return {};
};
