import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { env } from "./cfg";
interface model_cfg {
    [sector: string]: Record<string, string>;
}
let cfg: model_cfg | null = null;

export const load_models = (): model_cfg => {
    if (cfg) return cfg;
    const p = join(__dirname, "../../../models.yml");
    if (!existsSync(p)) {
        console.error("[MODELS] models.yml not found, using defaults");
        return get_defaults();
    }
    try {
        const yml = readFileSync(p, "utf-8");
        cfg = parse_yaml(yml);
        console.error(
            `[MODELS] Loaded models.yml (${Object.keys(cfg).length} sectors)`,
        );
        return cfg;
    } catch (e) {
        console.error("[MODELS] Failed to parse models.yml:", e);
        return get_defaults();
    }
};

import { parse } from "yaml";

const parse_yaml = (yml: string): model_cfg => {
    try {
        const parsed = parse(yml);
        return (parsed as model_cfg) || {};
    } catch (e) {
        console.error("[MODELS] Yaml parse error:", e);
        return {};
    }
};

const get_defaults = (): model_cfg => ({
    episodic: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "all-MiniLM-L6-v2",
    },
    semantic: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "all-MiniLM-L6-v2",
    },
    procedural: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "all-MiniLM-L6-v2",
    },
    emotional: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "all-MiniLM-L6-v2",
    },
    reflective: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-large",
        gemini: "models/embedding-001",
        aws: "amazon.titan-embed-text-v2:0",
        local: "all-mpnet-base-v2",
    },
});

export const get_model = (sector: string, provider: string): string => {
    // Environment variable overrides
    if (provider === "ollama" && env.ollama_model) {
        return env.ollama_model || "nomic-embed-text";
    }
    if (provider === "openai" && env.openai_model) {
        return env.openai_model;
    }
    if (provider === "gemini" && env.gemini_model) {
        return env.gemini_model;
    }

    const cfg = load_models();
    return (
        cfg[sector]?.[provider] ||
        cfg.semantic?.[provider] ||
        "nomic-embed-text"
    );
};

export const get_provider_config = (provider: string): any => {
    return {};
};
