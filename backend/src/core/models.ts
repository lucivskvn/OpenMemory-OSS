import { readFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { log } from "../core/log";

interface model_cfg {
    [sector: string]: Record<string, string>;
}
let cfg: model_cfg | null = null;

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

export const load_models = (): model_cfg => {
    if (cfg) return cfg;
    const p = join(__dirname, "../../../models.yml");
    if (!existsSync(p)) {
        // log.warn("[MODELS] models.yml not found, using defaults");
        return get_defaults();
    }
    try {
        const yml = readFileSync(p, "utf-8");
        cfg = yaml.load(yml) as model_cfg;
        log.info(
            `[MODELS] Loaded models.yml (${Object.keys(cfg || {}).length} sectors)`,
        );
        return cfg;
    } catch (e) {
        log.error("[MODELS] Failed to parse models.yml", { error: e });
        return get_defaults();
    }
};

export const get_model = (sector: string, provider: string): string => {
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
