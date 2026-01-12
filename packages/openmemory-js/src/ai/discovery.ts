/**
 * Auto-Discovery AI component for OpenMemory.
 * Scans local environment for AI capabilities (e.g., Ollama) and auto-configures the system.
 */
import { env } from "../core/cfg";
import { getPersistedConfig, setPersistedConfig } from "../core/persisted_cfg";
import { logger } from "../utils/logger";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/**
 * Scans for local AI capabilities (Ollama) and automatically configures the system
 * if no other configuration is present.
 * 
 * @async
 * @returns {Promise<void>}
 */
export const runAutoDiscovery = async () => {
    try {
        // 1. Check if System Config is already set
        const existingOllama = await getPersistedConfig(null, "ollama");
        if (existingOllama) {
            logger.debug(
                "[DISCOVERY] System already configured. Skipping auto-discovery.",
            );
            return;
        }

        // 2. Scan Ollama
        const url = env.ollamaUrl || OLLAMA_DEFAULT_URL;
        logger.info(`[DISCOVERY] Scanning for Local Models at ${url}...`);

        // Modern 2026 Optimization: Use AbortSignal.timeout
        const signal = AbortSignal.timeout(2000);

        const res = await fetch(`${url}/api/tags`, { signal });

        if (!res.ok) throw new Error(`Ollama returned ${res.status}`);

        const data = (await res.json()) as { models: Array<{ name: string }> };
        const models = data.models || [];

        if (models.length === 0) {
            logger.warn("[DISCOVERY] Ollama detected but no models found.");
            return;
        }

        // 3. Select Best LLM Model (Heuristic)
        const llmPreferences = [
            "llama4",
            "llama3.3",
            "llama3.2",
            "mistral-large",
            "gemma-3",
            "phi-4",
            "qwen",
        ];
        let selectedModel = models[0].name;
        for (const pref of llmPreferences) {
            const match = models.find((m) => m.name.includes(pref));
            if (match) {
                selectedModel = match.name;
                break;
            }
        }

        // 4. Select Best Embedding Models (Scenario-based)
        const embMap: Record<string, string> = {};
        const embFast = models.find(m => m.name.includes("nomic-embed") || m.name.includes("all-minilm"));
        const embLarge = models.find(m => m.name.includes("mxbai-embed-large") || m.name.includes("bge-large"));
        const embSemantic = models.find(m => m.name.includes("nomic-embed") || m.name.includes("bge-m3") || m.name.includes("gte-large"));

        if (embFast) embMap.fast = embFast.name;
        if (embLarge) embMap.large = embLarge.name;
        if (embSemantic) embMap.semantic = embSemantic.name;

        // 5. Configure System
        logger.info(
            `[DISCOVERY] Auto-configuring System with Local Model: ${selectedModel}`,
        );

        await setPersistedConfig(null, "ollama", {
            baseUrl: url,
            model: selectedModel,
        });

        if (Object.keys(embMap).length > 0) {
            logger.info(`[DISCOVERY] Auto-configuring Embeddings: ${Object.values(embMap).join(", ")}`);
            await setPersistedConfig(null, "ollama_embeddings", embMap);
        }

        logger.info(
            "[DISCOVERY] System configuration updated via Auto-Discovery.",
        );
    } catch (e: unknown) {
        // Silent failure is acceptable as it just means no local AI found
        const msg = e instanceof Error ? e.message : String(e);
        logger.debug(`[DISCOVERY] Auto-discovery skipped: ${msg}`);
    }
};
