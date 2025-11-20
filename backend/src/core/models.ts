import { readFileSync, existsSync } from "fs";
import { join } from "path";
import logger from "./logger";

interface model_cfg {
    [sector: string]: Record<string, string>;
}
let cfg: model_cfg | null = null;

export const load_models = (): model_cfg => {
    if (cfg) return cfg;
    // Allow tests or deployments to override the models.yml path via env
    const p = process.env.OM_MODELS_PATH || join(__dirname, "../../../models.yml");
    if (!existsSync(p)) {
        console.warn("[MODELS] models.yml not found, using defaults");
        return get_defaults();
    }
    try {
        const yml = readFileSync(p, "utf-8");
        const parsed = parse_yaml(yml);
        if (!parsed || Object.keys(parsed).length === 0) {
            console.warn("[MODELS] Parsed models.yml is empty or invalid, using defaults");
            cfg = get_defaults();
            return cfg;
        }
        cfg = parsed;
        logger.info({ sectors: Object.keys(cfg).length }, 'Loaded models.yml');
        return cfg;
    } catch (e) {
        console.error("[MODELS] Failed to parse models.yml:", e);
        return get_defaults();
    }
};

const parse_yaml = (yml: string): model_cfg => {
    const lines = yml.split("\n");
    const obj: model_cfg = {};
    let cur_sec: string | null = null;
    for (let line of lines) {
        // Remove inline comments
        const withoutComment = line.replace(/#.*/, "");
        const trim = withoutComment.trim();
        if (!trim) continue;
        const indent = line.search(/\S/);
        const [key, ...val_parts] = trim.split(":");
        const rawVal = val_parts.join(":").trim();
        // If value is empty, this is a section header
        if (indent === 0 && rawVal) {
        // This looks like a root-level key with a value; treat as malformed and skip
            continue;
        } else if (indent === 0) {
            cur_sec = key;
            obj[cur_sec] = {};
        } else if (cur_sec && rawVal) {
            obj[cur_sec][key] = rawVal;
        }
    }
    return obj;
};

const get_defaults = (): model_cfg => ({
    episodic: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        local: "all-MiniLM-L6-v2",
    },
    semantic: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        local: "all-MiniLM-L6-v2",
    },
    procedural: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        local: "all-MiniLM-L6-v2",
    },
    emotional: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-small",
        gemini: "models/embedding-001",
        local: "all-MiniLM-L6-v2",
    },
    reflective: {
        ollama: "nomic-embed-text",
        openai: "text-embedding-3-large",
        gemini: "models/embedding-001",
        local: "all-mpnet-base-v2",
    },
});

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
