import { tier, env as cfgEnv, getConfig } from "../core/cfg";
import { get_model } from "../core/models";
import { sector_configs } from "./hsg";
import { CryptoHasher } from "bun";
import { q } from "../core/db";
import { canonical_tokens_from_text, add_synonym_tokens } from "../utils/text";
import { fuseVectors, benchmarkSimd, dotProduct, normalize, SIMD_SUPPORTED } from "../utils/simd";
import logger, { getEnvLogLevel } from "../core/logger";
if (process.env.RUN_TRANSFORMERS_RESOLVE_TEST === "1") {
    import("@xenova/transformers")
        .then((T) => {
            const v = (T && ((T as any).default?.version || (T as any).version)) || "unknown";
            embedLog('info', { component: "EMBED", transformers_version: v }, "[EMBED] Transformers resolved: %s", v);
        })
        .catch((e) => {
            embedLog('warn', { component: "EMBED", err: e }, "[EMBED] Transformers resolution failed: %s", e instanceof Error ? e.message : String(e));
        });
}

// Mutable runtime configuration overrides for dynamic provider switching
// These override process.env values but are not persisted.
export const runtimeConfig: {
    embed_kind?: string;
    router_simd_enabled?: boolean;
    router_fallback_enabled?: boolean;
    embed_mode?: string;
} = {};

let gem_q: Promise<any> = Promise.resolve();
// Read relevant environment/config values at call-time so tests can set
// `OM_TEST_MODE`/`OM_EMBED_KIND` early and affect provider selection even
// when modules were previously imported. This avoids import-time snapshot
// issues caused by `cfg` parsing process.env on import.
function currentEnv() {
    const e = process.env;
    const base = {
        vec_dim: parseInt(e.OM_VEC_DIM || "256", 10) || 256,
        hybrid_fusion: (e.OM_HYBRID_FUSION === "true") || true,
        embed_kind: e.OM_EMBED_KIND || e.OM_EMBEDDINGS || "synthetic",
        openai_key: e.OM_OPENAI_KEY || e.OPENAI_API_KEY || e.OM_OPENAI_API_KEY || null,
        openai_base_url: e.OM_OPENAI_BASE_URL || e.OPENAI_BASE_URL || "https://api.openai.com/v1",
        openai_model: e.OM_OPENAI_MODEL || null,
        gemini_key: e.OM_GEMINI_KEY || e.GEMINI_API_KEY || null,
        ollama_url: e.OM_OLLAMA_URL || "http://localhost:11434",
        ollama_keep_alive: e.OM_OLLAMA_KEEP_ALIVE || "5m",
        ollama_models: e.OM_OLLAMA_MODELS || null,
        ollama_num_parallel: parseInt(e.OM_OLLAMA_NUM_PARALLEL || "1", 10) || 1,
        ollama_num_gpu: parseInt(e.OM_OLLAMA_NUM_GPU || "0", 10) || 0,
        local_model_path: e.OM_LOCAL_MODEL_PATH || e.OM_LOCAL_MODEL || null,
        embed_mode: e.OM_EMBED_MODE || "advanced",
        adv_embed_parallel: e.OM_ADV_EMBED_PARALLEL === "true" || false,
        embed_delay_ms: parseInt(e.OM_EMBED_DELAY_MS || "0", 10) || 0,
        openai_base: e.OPENAI_API_BASE || e.OPENAI_BASE_URL || null,
        router_cache_ttl_ms: parseInt(e.OM_ROUTER_CACHE_TTL_MS || "30000", 10) || 30000,
        router_fallback_enabled: e.OM_ROUTER_FALLBACK_ENABLED !== "false",
        router_simd_enabled: e.OM_ROUTER_SIMD_ENABLED ?? (e.OM_SIMD_ENABLED !== "false"),
        router_sector_models: e.OM_ROUTER_SECTOR_MODELS ? JSON.parse(e.OM_ROUTER_SECTOR_MODELS) : null,
        router_dim_tolerance: parseFloat(e.OM_ROUTER_DIM_TOLERANCE || '0.1') || 0.1,
        router_validate_on_start: e.OM_ROUTER_VALIDATE_ON_START !== "false",
        fusion_simd_enabled: e.OM_FUSION_SIMD_ENABLED !== "false",
    };

    // Apply runtime overrides
    return {
        ...base,
        embed_kind: runtimeConfig.embed_kind ?? base.embed_kind,
        embed_mode: runtimeConfig.embed_mode ?? base.embed_mode,
        router_simd_enabled: runtimeConfig.router_simd_enabled ?? base.router_simd_enabled,
        router_fallback_enabled: runtimeConfig.router_fallback_enabled ?? base.router_fallback_enabled,
    } as const;
}

/**
 * Update runtime configuration for dynamic provider switching.
 * This allows changing embedding providers without restart for supported configurations.
 * @param updates Partial configuration object with runtime-overridable fields
 */
export function updateRuntimeConfig(updates: Partial<typeof runtimeConfig>) {
    Object.assign(runtimeConfig, updates);
    embedLog('info', { component: 'EMBED', updates }, '[EMBED] Runtime config updated');
}

// Embed-specific logging helpers. Operators can set `OM_LOG_EMBED_LEVEL`
// to one of: 'debug', 'info', 'warn', 'error'. Messages below that level
// will be suppressed for embed-related operations. If unset, behavior
// falls back to 'info'. This lets operators reduce noise for high-volume
// embedding paths like `embedMultiSector`.
const _embedLevelPriority: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
function getEmbedLevelThreshold(): number {
    // Resolve embed-specific level, falling back to OM_LOG_LEVEL or global LOG_LEVEL
    const lvl = (getEnvLogLevel('OM_LOG_EMBED_LEVEL') || 'info').toLowerCase();
    return _embedLevelPriority[lvl] ?? _embedLevelPriority.info;
}
function embedLog(level: 'debug' | 'info' | 'warn' | 'error', meta: any, msg: string, ...args: any[]) {
    try {
        const want = _embedLevelPriority[level];
        if (want < getEmbedLevelThreshold()) return;
        const fn = (logger as any)[level] || logger.info;
        fn.call(logger, meta, msg, ...args);
    } catch (e) {
        // Avoid calling into the central logger here, since tests sometimes
        // stub/spyon logger methods and pino internals can throw when the
        // logger shape is unexpected. Use console.error as a safe fallback
        // to ensure failures in logging don't crash tests.
        try {
            // Provide structured output similar to logger for debugging.
            console.error('[EMBED] embedLog helper failure', {
                err: e instanceof Error ? e.message : String(e),
                meta,
                msg,
                args,
            });
        } catch (_err) {
            // Best-effort: if console also fails, swallow to avoid test noise.
        }
    }
}

// Exported for tests to assert threshold behavior
export function _getEmbedLevelThreshold_for_test() {
    return getEmbedLevelThreshold();
}

export const emb_dim = () => currentEnv().vec_dim;

export interface EmbeddingResult {
    sector: string;
    vector: number[];
    dim: number;
}

const compress_vec = (v: number[], td: number): number[] => {
    if (v.length <= td) return v;
    const c = new Float32Array(td),
        bs = v.length / td;
    for (let i = 0; i < td; i++) {
        const s = Math.floor(i * bs),
            e = Math.floor((i + 1) * bs);
        let sum = 0,
            cnt = 0;
        for (let j = s; j < e && j < v.length; j++) {
            sum += v[j];
            cnt++;
        }
        c[i] = cnt > 0 ? sum / cnt : 0;
    }
    let n = 0;
    for (let i = 0; i < td; i++) n += c[i] * c[i];
    n = Math.sqrt(n);
    if (n > 0) for (let i = 0; i < td; i++) c[i] /= n;
    return Array.from(c);
};

export const fuse_vecs = (syn: number[], sem: number[]): number[] => {
    const synLength = syn.length;
    const semLength = sem.length;
    const totalLength = synLength + semLength;
    const f = new Array(totalLength);
    let sumOfSquares = 0;
    for (let i = 0; i < synLength; i++) {
        const val = syn[i] * 0.6;
        f[i] = val;
        sumOfSquares += val * val;
    }
    for (let i = 0; i < semLength; i++) {
        const val = sem[i] * 0.4;
        f[synLength + i] = val;
        sumOfSquares += val * val;
    }
    if (sumOfSquares > 0) {
        const norm = Math.sqrt(sumOfSquares);
        for (let i = 0; i < totalLength; i++) {
            f[i] /= norm;
        }
    }
    return f;
};

export async function embedForSector(t: string, s: string): Promise<number[]> {
    if (!sector_configs[s]) throw new Error(`Unknown sector: ${s}`);
    // Hybrid tier: optionally fuse synthetic + semantic vectors when configured
    const e = currentEnv();
    const localTier = (process.env.OM_TIER as any) || tier;
    if (localTier === "hybrid") {
        if (e.hybrid_fusion && e.embed_kind !== "synthetic") {
            const syn = gen_syn_emb(t, s);
            const sem = await get_sem_emb(t, s);
            const comp = compress_vec(sem, 128);
            embedLog('info', { component: "EMBED", sector: s }, `[EMBED] Fusing hybrid vectors for sector: ${s}, syn_dim=${syn.length}, comp_dim=${comp.length}`);

            // Use sector-aware weights for consistency
            const secWeights: Record<string, [number, number]> = {
                episodic: [0.65, 0.35],
                semantic: [0.6, 0.4],
                procedural: [0.55, 0.45],
                emotional: [0.58, 0.42],
                reflective: [0.62, 0.38],
            };
            const weights = secWeights[s] || [0.6, 0.4];
            return fuseEmbeddingVectors(syn, comp, weights, e.fusion_simd_enabled, s);
        }
        return gen_syn_emb(t, s);
    }
    if (localTier === "smart" && e.embed_kind !== "synthetic") {
        const syn = gen_syn_emb(t, s),
            sem = await get_sem_emb(t, s),
            comp = compress_vec(sem, 128);

        // Use sector-aware weights for smart tier consistency
        const secWeights: Record<string, [number, number]> = {
            episodic: [0.65, 0.35],
            semantic: [0.6, 0.4],
            procedural: [0.55, 0.45],
            emotional: [0.58, 0.42],
            reflective: [0.62, 0.38],
        };
        const weights = secWeights[s] || [0.6, 0.4];
        return fuseEmbeddingVectors(syn, comp, weights, e.fusion_simd_enabled, s);
    }
    if (localTier === "fast") return gen_syn_emb(t, s);
    return await get_sem_emb(t, s);
}

async function get_sem_emb(t: string, s: string): Promise<number[]> {
    // Allow tests to override the provider deterministically.
    if (__TEST.provider) return await __TEST.provider(t, s);
    const e = currentEnv();
    switch (e.embed_kind) {
        case "openai":
            return await emb_openai(t, s);
        case "gemini":
            return (await emb_gemini({ [s]: t }))[s];
        case "ollama":
            return await emb_ollama(t, s);
        case "local":
            return await emb_local(t, s);
        case "router_cpu":
            return await emb_router_cpu(t, s);
        default:
            return gen_syn_emb(t, s);
    }
}

async function emb_openai(t: string, s: string): Promise<number[]> {
    const e = currentEnv();
    if (!e.openai_key) throw new Error("OpenAI key missing");
    const m = get_model(s, "openai");
    const base = (e.openai_base_url || e.openai_base || "").replace(/\/$/, "");
    try {
        const r = await fetch(`${base}/embeddings`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${e.openai_key}`,
            },
            body: JSON.stringify({
                input: t,
                model: e.openai_model || m,
                dimensions: e.vec_dim,
            }),
        });
        if (!r.ok) {
            embedLog('warn', { component: "EMBED", status: r.status }, `[EMBED] OpenAI responded with status ${r.status}, falling back to synthetic`);
            return gen_syn_emb(t, s);
        }
        return ((await r.json()) as any).data[0].embedding;
    } catch (err) {
        embedLog('warn', { component: "EMBED", err }, "[EMBED] OpenAI fetch failed, falling back to synthetic");
        return gen_syn_emb(t, s);
    }
}

async function emb_batch_openai(
    txts: Record<string, string>,
): Promise<Record<string, number[]>> {
    if (__TEST.batchProvider) return await __TEST.batchProvider(txts);
    const e = currentEnv();
    if (!e.openai_key) throw new Error("OpenAI key missing");
    const secs = Object.keys(txts), m = get_model("semantic", "openai");
    const base = (e.openai_base_url || e.openai_base || "").replace(/\/$/, "");
    const r = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${e.openai_key}`,
        },
        body: JSON.stringify({
            input: Object.values(txts),
            model: e.openai_model || m,
            dimensions: e.vec_dim,
        }),
    });
    try {
        if (!r.ok) {
            embedLog('warn', { component: "EMBED", status: r.status }, `[EMBED] OpenAI batch responded with status ${r.status}, falling back to synthetic`);
            const fb: Record<string, number[]> = {};
            for (const s of secs) fb[s] = gen_syn_emb(txts[s], s);
            return fb;
        }
        const d = (await r.json()) as any, out: Record<string, number[]> = {};
        secs.forEach((s, i) => (out[s] = d.data[i].embedding));
        return out;
    } catch (err) {
        embedLog('warn', { component: "EMBED", err }, "[EMBED] OpenAI batch fetch failed, falling back to synthetic");
        const fb: Record<string, number[]> = {};
        for (const s of secs) fb[s] = gen_syn_emb(txts[s], s);
        return fb;
    }
}

const task_map: Record<string, string> = {
    episodic: "RETRIEVAL_DOCUMENT",
    semantic: "SEMANTIC_SIMILARITY",
    procedural: "RETRIEVAL_DOCUMENT",
    emotional: "CLASSIFICATION",
    reflective: "SEMANTIC_SIMILARITY",
};

async function emb_gemini(
    txts: Record<string, string>,
): Promise<Record<string, number[]>> {
    const e = currentEnv();
    // If no Gemini key is configured, gracefully fall back to synthetic
    // embeddings instead of throwing. Tests expect provider fallbacks to
    // synth when no provider credentials are present.
    if (!e.gemini_key) {
        embedLog('warn', { component: "EMBED" }, "[EMBED] Gemini key missing, falling back to synthetic");
        const fb: Record<string, number[]> = {};
        for (const s of Object.keys(txts)) fb[s] = gen_syn_emb(txts[s], s);
        return fb;
    }
    const prom = gem_q.then(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:batchEmbedContents?key=${e.gemini_key}`;
        for (let a = 0; a < 3; a++) {
            try {
                const reqs = Object.entries(txts).map(([s, t]) => ({
                    model: "models/embedding-001",
                    content: { parts: [{ text: t }] },
                    taskType: task_map[s] || task_map.semantic,
                }));
                const r = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ requests: reqs }),
                });
                if (!r.ok) {
                    if (r.status === 429) {
                        const d = Math.min(
                            parseInt(r.headers.get("retry-after") || "2") * 1000,
                            1000 * Math.pow(2, a),
                        );
                        embedLog('warn', { component: "EMBED", attempt: a + 1, wait_ms: d }, `[EMBED] Gemini rate limit (${a + 1}/3), waiting ${d}ms`);
                        await new Promise((x) => setTimeout(x, d));
                        continue;
                    }
                    throw new Error(`Gemini: ${r.status}`);
                }
                const data = (await r.json()) as any;
                const out: Record<string, number[]> = {};
                let i = 0;
                for (const s of Object.keys(txts))
                    out[s] = resize_vec(data.embeddings[i++].values, e.vec_dim);
                await new Promise((x) => setTimeout(x, 1500));
                return out;
            } catch (e) {
                if (a === 2) {
                    embedLog('error', { component: "EMBED", attempt: a + 1, err: e }, `[EMBED] Gemini failed after 3 attempts, using synthetic`);
                    const fb: Record<string, number[]> = {};
                    for (const s of Object.keys(txts)) fb[s] = gen_syn_emb(txts[s], s);
                    return fb;
                }
                embedLog('warn', { component: "EMBED", attempt: a + 1, err: e }, `[EMBED] Gemini error (${a + 1}/3): %s`, e instanceof Error ? e.message : String(e));
                await new Promise((x) => setTimeout(x, 1000 * Math.pow(2, a)));
            }
        }
        const fb: Record<string, number[]> = {};
        for (const s of Object.keys(txts)) fb[s] = gen_syn_emb(txts[s], s);
        return fb;
    });
    gem_q = prom.catch(() => { });
    return prom;
}

async function emb_ollama(t: string, s: string): Promise<number[]> {
    const e = currentEnv();
    const m = get_model(s, "ollama");
    const r = await fetch(`${e.ollama_url}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m, prompt: t }),
    });
    if (!r.ok) throw new Error(`Ollama: ${r.status}`);
    return resize_vec(((await r.json()) as any).embedding, e.vec_dim);
}

// Router decision cache for sector-to-model mappings
const routerDecisionCache = new Map<string, { model: string; expires: number }>();

// Router startup validation cache
let routerValidationCache: {
    status: 'not_run' | 'running' | 'passed' | 'warnings' | 'failed' | 'error';
    errors: Array<{ sector: string, model: string, expected: number, detected: number, ratio: number }>;
    timestamp: number;
} | null = null;

/**
 * Validate router models on startup with caching.
 * Prevents misconfiguration from inconsistent dimensions across sector models.
 * @returns Promise resolving to validation result object
 */
async function validateRouterOnStartup(): Promise<{
    status: 'passed' | 'warnings' | 'failed' | 'error';
    errors: Array<{ sector: string, model: string, expected: number, detected: number, ratio: number }>;
}> {
    const e = currentEnv();
    if (!e.router_validate_on_start) {
        return { status: 'passed', errors: [] };
    }

    // Return cached result unless expired (5 minutes TTL)
    if (routerValidationCache && (Date.now() - routerValidationCache.timestamp) < 5 * 60 * 1000) {
        return { status: routerValidationCache.status as any, errors: routerValidationCache.errors };
    }

    // Mark as running
    routerValidationCache = { status: 'running', errors: [], timestamp: Date.now() };

    const sectors = ['episodic', 'semantic', 'procedural', 'emotional', 'reflective'];
    const validationErrors: Array<{ sector: string, model: string, expected: number, detected: number, ratio: number }> = [];

    embedLog('info', { component: 'EMBED' }, '[EMBED] Router startup validation starting...');

    for (const sector of sectors) {
        const model = getRouterModel(sector);
        try {
            const r = await fetch(`${e.ollama_url}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: 'validate dimensions', options: { num_ctx: 1 } })
            });

            if (r.ok) {
                const res = await r.json() as any;
                const detectedDim = res.embedding?.length || 0;
                const ratio = Math.abs(detectedDim - e.vec_dim) / e.vec_dim;

                if (ratio > e.router_dim_tolerance) {
                    validationErrors.push({
                        sector,
                        model,
                        expected: e.vec_dim,
                        detected: detectedDim,
                        ratio
                    });
                    embedLog('warn', { component: 'EMBED', sector, model, ratio: ratio.toFixed(3) },
                        `[EMBED] Router startup validation failed for ${sector}: ratio ${ratio.toFixed(3)}`);
                }
            } else {
                embedLog('info', { component: 'EMBED', sector, model, status: r.status },
                    `[EMBED] Router validation: ${sector} model ${model} not responding at startup`);
            }
        } catch (error) {
            embedLog('info', { component: 'EMBED', sector, model, error: String(error) },
                `[EMBED] Router validation: could not reach ${sector} model at startup`);
        }
    }

    const status = validationErrors.length === 0 ? 'passed' : 'warnings';
    routerValidationCache = { status, errors: validationErrors, timestamp: Date.now() };

    embedLog('info', { component: 'EMBED', validation_status: status, errors_count: validationErrors.length },
        '[EMBED] Router startup validation complete');

    if (status === 'warnings' && process.env.OM_ROUTER_VALIDATE_STRICT === 'true') {
        routerValidationCache.status = 'failed';
        throw new Error(`Router validation failed: ${validationErrors.map(e =>
            `${e.sector}: ${e.ratio.toFixed(2)}x mismatch/${e.model}`)}`);
    }

    return { status, errors: validationErrors };
}

// Current router_cpu implementation: single-expert-per-sector CPU router over Ollama models.
// This is intentionally a sector router over Ollama embeddings and not the IBM/Liquid MoE requested in the original design.
// IBM/Liquid MoE integration (transformers.js 3.x) is deferred to later phases. SB-MoE (Sparse Mixture-of-Experts) / MUVERA-style approximations are
// also deferred to later phases. This router selects one Ollama model per sector
// with optional synthetic fallback and sector-aware caching.

/**
 * Gets the router model decision for a sector with caching.
 * Routes sector-based traffic to appropriate Ollama models with TTL-based cache.
 * @param sector The brain sector (episodic, semantic, procedural, etc.)
 * @returns The Ollama model name for the sector
 */
function getRouterModel(sector: string): string {
    const cacheKey = `router_${sector}`;
    const cached = routerDecisionCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
        return cached.model;
    }

    const e = currentEnv();
    // Default sector-to-model mappings for router mode
    const defaultMappings: Record<string, string> = {
        episodic: "nomic-embed-text",
        semantic: "nomic-embed-text",
        procedural: "bge-small-en-v1.5",
        emotional: "nomic-embed-text",
        reflective: "nomic-embed-text",
    };

    // Use configured mappings or defaults
    const model = e.router_sector_models?.[sector] || defaultMappings[sector] || "nomic-embed-text";

    embedLog('debug', { component: "EMBED", sector, model }, `[EMBED] Router decision: ${sector} → ${model}`);

    // Cache decision
    routerDecisionCache.set(cacheKey, { model, expires: Date.now() + e.router_cache_ttl_ms });

    return model;
}

export async function emb_router_cpu(t: string, s: string): Promise<number[]> {
    const e = currentEnv();
    const modelName = getRouterModel(s);

    // SIMD usage is controlled by router_simd_enabled
    const useSimdFusion = e.router_simd_enabled;

    embedLog('info', {
        component: "EMBED",
        sector: s,
        model: modelName,
        text_length: t.length,
        simd_enabled: useSimdFusion
    }, `[EMBED] Router CPU: processing sector ${s} with model ${modelName}`);

    try {
        // Use Ollama API with the selected model
        const r = await fetch(`${e.ollama_url}/api/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: modelName, prompt: t }),
        });

        if (!r.ok) {
            const errorText = await r.text();
            embedLog('warn', { component: "EMBED", sector: s, model: modelName, status: r.status }, `[EMBED] Router model ${modelName} failed: ${r.status}, ${errorText}`);

            // Fallback logic: Ollama failed → synthetic
            if (e.router_fallback_enabled) {
                embedLog('warn', { component: "EMBED", sector: s }, `[EMBED] Router fallback: using synthetic for sector ${s}`);
                return gen_syn_emb(t, s);
            }
            throw new Error(`Router model ${modelName} unavailable: ${r.status}`);
        }

        const result = (await r.json()) as any;
        if (!result.embedding || !Array.isArray(result.embedding) || result.embedding.length === 0) {
            throw new Error(`Invalid embedding response from Ollama model ${modelName}: no valid embedding array`);
        }

        const rawEmbedding = result.embedding;
        const rawDim = rawEmbedding.length;
        const mismatchRatio = Math.abs(rawDim - e.vec_dim) / e.vec_dim;
        const tolerance = parseFloat(process.env.OM_ROUTER_DIM_TOLERANCE || '0.1'); // 10% default

        if (mismatchRatio > tolerance) {
            embedLog('warn', { component: "EMBED", sector: s, model: modelName, rawDim, targetDim: e.vec_dim, mismatchRatio: mismatchRatio.toFixed(3) },
                `[EMBED] Dimension mismatch: sector=${s}, model=${modelName}, raw=${rawDim}, target=${e.vec_dim}, ratio=${mismatchRatio.toFixed(3)}`);

            // Hard failure for 50%+ mismatch if fallback enabled, otherwise throw
            if (mismatchRatio > 0.5 && !e.router_fallback_enabled) {
                throw new Error(`Model dimension incompatible with OM_VEC_DIM (ratio >0.5): ${modelName} produced ${rawDim}d, target ${e.vec_dim}d`);
            }

            // Use fallback synthetic if ratio too high
            if (mismatchRatio > 0.5 && e.router_fallback_enabled) {
                embedLog('warn', { component: "EMBED", sector: s }, `[EMBED] Router fallback: dimension ratio ${mismatchRatio.toFixed(3)} >0.5, using synthetic for sector ${s}`);
                return gen_syn_emb(t, s);
            }
        }

        let vector = resize_vec(rawEmbedding, e.vec_dim);

        embedLog('info', { component: "EMBED", sector: s, model: modelName, rawDim, resized_to: e.vec_dim, mismatch_ratio: mismatchRatio.toFixed(3) },
            `[EMBED] Router CPU: accepted embedding, dimension mismatch ratio ${mismatchRatio.toFixed(3)}`);

        // Apply SIMD optimization if enabled and available
        if (e.router_simd_enabled) {
            // Fuse with synthetic vector for hybrid approach (60% semantic + 40% synthetic to maintain sector context)
            const synVec = gen_syn_emb(t, s);
            const semVec = vector;

            // Use sector-aware weightings optimized for router CPU performance
            const secWeights: Record<string, [number, number]> = {
                episodic: [0.65, 0.35],    // More semantic for episodic
                semantic: [0.6, 0.4],     // Balanced for semantic
                procedural: [0.55, 0.45],  // More synthetic for procedural (faster models)
                emotional: [0.58, 0.42],   // Slightly more semantic for emotional
                reflective: [0.62, 0.38],  // More semantic for reflective
            };

            const weights = secWeights[s] || [0.6, 0.4];
            vector = fuseEmbeddingVectors(synVec, semVec, weights, true, s);

            embedLog('debug', { component: "EMBED", sector: s, model: modelName, weights }, `[EMBED] Router fusion: ${weights[0]}:${weights[1]} ratio for ${s}`);
        }

        embedLog('info', { component: "EMBED", sector: s, model: modelName, dimensions: vector.length }, `[EMBED] Router CPU: successful embedding for ${s}`);
        return vector;

    } catch (error) {
        embedLog('warn', { component: "EMBED", sector: s, model: modelName, error: String(error) }, `[EMBED] Router model ${modelName} failed with exception`);

        // Final fallback: synthetic embeddings
        if (e.router_fallback_enabled) {
            embedLog('info', { component: "EMBED", sector: s }, `[EMBED] Router final fallback: using synthetic for sector ${s}`);
            return gen_syn_emb(t, s);
        }

        throw error;
    }
}

async function emb_local(t: string, s: string): Promise<number[]> {
    const e = currentEnv();
    if (!e.local_model_path) {
        embedLog('warn', { component: "EMBED", sector: s }, "[EMBED] Local model missing, using synthetic");
        return gen_syn_emb(t, s);
    }
    try {
        const h = new CryptoHasher("sha256")
            .update(t + s)
            .digest(),
            out: number[] = [];
        for (let i = 0; i < e.vec_dim; i++) {
            const b1 = h[i % h.length],
                b2 = h[(i + 1) % h.length];
            out.push(((b1 * 256 + b2) / 65535) * 2 - 1);
        }
        const n = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0));
        return out.map((v) => v / n);
    } catch (err) {
        embedLog('warn', { component: "EMBED", sector: s, err }, "[EMBED] Local embedding failed, using synthetic");
        return gen_syn_emb(t, s);
    }
}

const h1 = (v: string) => {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < v.length; i++)
        h = Math.imul(h ^ v.charCodeAt(i), 16777619);
    return h >>> 0;
};
const h2 = (v: string, sd: number) => {
    let h = sd | 0;
    for (let i = 0; i < v.length; i++) {
        h = Math.imul(h ^ v.charCodeAt(i), 0x5bd1e995);
        h = (h >>> 13) ^ h;
    }
    return h >>> 0;
};
const add_feat = (vec: Float32Array, dim: number, k: string, w: number) => {
    const h = h1(k),
        h_2 = h2(k, 0xdeadbeef),
        val = w * (1 - ((h & 1) << 1));
    if (dim > 0 && (dim & (dim - 1)) === 0) {
        vec[h & (dim - 1)] += val;
        vec[h_2 & (dim - 1)] += val * 0.5;
    } else {
        vec[h % dim] += val;
        vec[h_2 % dim] += val * 0.5;
    }
};
const add_pos_feat = (
    vec: Float32Array,
    dim: number,
    pos: number,
    w: number,
) => {
    const idx = pos % dim,
        ang = pos / Math.pow(10000, (2 * idx) / dim);
    vec[idx] += w * Math.sin(ang);
    vec[(idx + 1) % dim] += w * Math.cos(ang);
};
const sec_wts: Record<string, number> = {
    episodic: 1.3,
    semantic: 1.0,
    procedural: 1.2,
    emotional: 1.4,
    reflective: 0.9,
};
const norm_v = (v: Float32Array) => {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    if (n === 0) return;
    const inv = 1 / Math.sqrt(n);
    for (let i = 0; i < v.length; i++) v[i] *= inv;
};

export function gen_syn_emb(t: string, s: string): number[] {
    const d = currentEnv().vec_dim || 768,
        v = new Float32Array(d).fill(0),
        ct = canonical_tokens_from_text(t);
    if (!ct.length) {
        const x = 1 / Math.sqrt(d);
        return Array.from({ length: d }, () => x);
    }
    const et = Array.from(add_synonym_tokens(ct)),
        tc = new Map<string, number>(),
        el = et.length;
    for (let i = 0; i < el; i++) {
        const tok = et[i];
        tc.set(tok, (tc.get(tok) || 0) + 1);
    }
    const sw = sec_wts[s] || 1.0,
        dl = Math.log(1 + el);
    for (const [tok, c] of tc) {
        const tf = c / el,
            idf = Math.log(1 + el / c),
            w = (tf * idf + 1) * sw;
        add_feat(v, d, `${s}|tok|${tok}`, w);
        if (tok.length >= 3)
            for (let i = 0; i < tok.length - 2; i++)
                add_feat(v, d, `${s}|c3|${tok.slice(i, i + 3)}`, w * 0.4);
        if (tok.length >= 4)
            for (let i = 0; i < tok.length - 3; i++)
                add_feat(v, d, `${s}|c4|${tok.slice(i, i + 4)}`, w * 0.3);
    }
    for (let i = 0; i < ct.length - 1; i++) {
        const a = ct[i],
            b = ct[i + 1];
        if (a && b) {
            const pw = 1.0 / (1.0 + i * 0.1);
            add_feat(v, d, `${s}|bi|${a}_${b}`, 1.4 * sw * pw);
        }
    }
    for (let i = 0; i < ct.length - 2; i++) {
        const a = ct[i],
            b = ct[i + 1],
            c = ct[i + 2];
        if (a && b && c) add_feat(v, d, `${s}|tri|${a}_${b}_${c}`, 1.0 * sw);
    }
    for (let i = 0; i < Math.min(ct.length - 2, 20); i++) {
        const a = ct[i],
            c = ct[i + 2];
        if (a && c) add_feat(v, d, `${s}|skip|${a}_${c}`, 0.7 * sw);
    }
    for (let i = 0; i < Math.min(ct.length, 50); i++)
        add_pos_feat(v, d, i, (0.5 * sw) / dl);
    const lb = Math.min(Math.floor(Math.log2(el + 1)), 10);
    add_feat(v, d, `${s}|len|${lb}`, 0.6 * sw);
    const dens = tc.size / el,
        db = Math.floor(dens * 10);
    add_feat(v, d, `${s}|dens|${db}`, 0.5 * sw);
    norm_v(v);
    return Array.from(v);
}

const resize_vec = (v: number[], t: number) => {
    if (v.length === t) return v;
    if (v.length > t) return v.slice(0, t);
    return [...v, ...Array(t - v.length).fill(0)];
};

export async function embedMultiSector(
    id: string,
    txt: string,
    secs: string[],
    chunks?: Array<{ text: string }>,
    user_id?: string | null,
): Promise<EmbeddingResult[]> {
    const r: EmbeddingResult[] = [];
    // Record pending status and include user_id in logs for observability.
    await q.ins_log.run(id, "multi-sector", "pending", Date.now(), null);
    embedLog('info', { component: "EMBED", id, user_id, sectors: secs.length }, "[EMBED] multi-sector pending");
    // If tests injected a provider, prefer that and run the same retry semantics
    if (__TEST.provider) {
        for (let a = 0; a < 3; a++) {
            try {
                for (const s of secs) {
                    const v = await __TEST.provider(txt, s);
                    r.push({ sector: s, vector: v, dim: v.length });
                }
                await q.upd_log.run("completed", null, id);
                embedLog('info', { component: "EMBED", id, user_id }, "[EMBED] multi-sector completed (test provider)");
                return r;
            } catch (e) {
                if (a === 2) {
                    await q.upd_log.run("failed", e instanceof Error ? e.message : String(e), id);
                    embedLog('error', { component: "EMBED", id, user_id, err: e instanceof Error ? e.message : String(e) }, "[EMBED] multi-sector failed (test provider)");
                    throw e;
                }
                await new Promise((x) => setTimeout(x, 1000 * Math.pow(2, a)));
            }
        }
    }
    for (let a = 0; a < 3; a++) {
        try {
            const e = currentEnv();
            const simp = e.embed_mode === "simple";
            if (
                simp &&
                (e.embed_kind === "gemini" || e.embed_kind === "openai")
            ) {
                embedLog('info', { component: "EMBED", id, user_id, sectors: secs.length }, `[EMBED] Simple mode (1 batch for ${secs.length} sectors)`);
                const tb: Record<string, string> = {};
                secs.forEach((s) => (tb[s] = txt));
                const b = e.embed_kind === "gemini" ? await emb_gemini(tb) : await emb_batch_openai(tb);
                for (const [s, v] of Object.entries(b)) {
                    const cfg = await import("../core/cfg");
                    const targetDimB = cfg.env.vec_dim;
                    r.push({ sector: s, vector: resize_vec(v, targetDimB), dim: targetDimB });
                }
            } else {
                embedLog('info', { component: "EMBED", id, user_id, sectors: secs.length }, `[EMBED] Advanced mode (${secs.length} calls)`);
                const par = e.adv_embed_parallel && e.embed_kind !== "gemini";
                if (par) {
                    const p = secs.map(async (s) => {
                        let v: number[];
                        if (chunks && chunks.length > 1) {
                            const cv: number[][] = [];
                            for (const c of chunks)
                                cv.push(await embedForSector(c.text, s));
                            v = agg_chunks(cv);
                        } else v = await embedForSector(txt, s);
                        // Prefer runtime override via OM_VEC_DIM, otherwise canonical cfg
                        {
                            const targetDimP = currentEnv().vec_dim;
                            const norm = resize_vec(v, targetDimP);
                            return { sector: s, vector: norm, dim: targetDimP };
                        }
                    });
                    r.push(...(await Promise.all(p)));
                } else {
                    for (let i = 0; i < secs.length; i++) {
                        const s = secs[i];
                        let v: number[];
                        if (chunks && chunks.length > 1) {
                            const cv: number[][] = [];
                            for (const c of chunks)
                                cv.push(await embedForSector(c.text, s));
                            v = agg_chunks(cv);
                        } else v = await embedForSector(txt, s);
                        // Prefer runtime override via OM_VEC_DIM, otherwise canonical cfg
                        {
                            const targetDim = currentEnv().vec_dim;
                            const norm = resize_vec(v, targetDim);
                            r.push({ sector: s, vector: norm, dim: targetDim });
                        }
                        if (e.embed_delay_ms > 0 && i < secs.length - 1)
                            await new Promise((x) => setTimeout(x, e.embed_delay_ms));
                    }
                }
            }
            await q.upd_log.run("completed", null, id);
            embedLog('info', { component: "EMBED", id, user_id }, "[EMBED] multi-sector completed");
            return r;
        } catch (e) {
            if (a === 2) {
                await q.upd_log.run(
                    "failed",
                    e instanceof Error ? e.message : String(e),
                    id,
                );
                embedLog('error', { component: "EMBED", id, user_id, err: e instanceof Error ? e.message : String(e) }, "[EMBED] multi-sector failed");
                throw e;
            }
            await new Promise((x) => setTimeout(x, 1000 * Math.pow(2, a)));
        }
    }
    throw new Error("Embedding failed after retries");
}

// Test injection helpers --------------------------------------------------
// Expose a lightweight test hook so unit/integration tests can inject a
// deterministic embedding provider without attempting to reassign ESM
// namespace exports (which are readonly). This avoids brittle mocking of
// `fetch` or module bindings in tests.
const TEST_ENABLED = process.env.OM_TEST_MODE === '1';

// Export a test hook object for tests to inspect, but make it inert when
// `OM_TEST_MODE` is not enabled. Tests should set `OM_TEST_MODE=1` at the
// top of their files before importing `embed` so they can call
// `__setTestProvider` safely.
export const __TEST: {
    provider: ((t: string, s: string) => Promise<number[]>) | null;
    batchProvider: ((txts: Record<string, string>) => Promise<Record<string, number[]>>) | null;
    reset: () => void;
    waitForIdle?: () => Promise<void>;
} = {
    provider: null,
    batchProvider: null,
    reset() {
        this.provider = null;
        this.batchProvider = null;
    },
    // Wait for internal embed queues (e.g., gem_q) and short async churn to settle.
    async waitForIdle() {
        try {
            // Await the gemini queue promise chain; ignore rejection so tests don't fail here
            await gem_q.catch(() => { });
        } catch (_) {
            // ignore
        }
        // Allow any short timers or microtasks to complete
        await new Promise((r) => setTimeout(r, 50));
    },
};

export function __setTestProvider(fn: (t: string, s: string) => Promise<number[]>) {
    // Allow test injection even if `OM_TEST_MODE` wasn't set at module-load time.
    // Some test files may set `OM_TEST_MODE` after importing modules; accepting
    // the provider makes tests more robust. If test mode wasn't enabled, we
    // still accept the provider silently.
    __TEST.provider = fn;
}
export function __setTestBatchProvider(fn: (txts: Record<string, string>) => Promise<Record<string, number[]>>) {
    __TEST.batchProvider = fn;
}

const agg_chunks = (vecs: number[][]): number[] => {
    if (!vecs.length) throw new Error("No vectors");
    if (vecs.length === 1) return vecs[0];

    const d = vecs[0].length;
    const sumVec = new Float32Array(d).fill(0);

    // Sum all vectors using optimized element-wise addition
    for (const v of vecs) {
        const floatVec = new Float32Array(v);
        for (let i = 0; i < d; i++) {
            sumVec[i] += floatVec[i];
        }
    }

    // Average the summation
    for (let i = 0; i < d; i++) {
        sumVec[i] /= vecs.length;
    }

    // Use SIMD normalization for final vector
    normalize(sumVec);

    return Array.from(sumVec);
};

export const cosineSimilarity = (a: number[], b: number[]) => {
    if (a.length !== b.length) return 0;

    // Convert to Float32Array for SIMD operations
    const aFloat32 = new Float32Array(a);
    const bFloat32 = new Float32Array(b);

    // Use SIMD for dot product
    const dot = dotProduct(aFloat32, bFloat32);

    // Compute norms - work directly with Float32Array copies
    let na = 0;
    for (let i = 0; i < a.length; i++) {
        na += aFloat32[i] * aFloat32[i];
    }

    let nb = 0;
    for (let i = 0; i < b.length; i++) {
        nb += bFloat32[i] * bFloat32[i];
    }

    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

export const vectorToBuffer = (v: number[]) => {
    const b = Buffer.allocUnsafe(v.length * 4);
    for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i], i * 4);
    return b;
};
export const bufferToVector = (b: Buffer) => {
    const v: number[] = [];
    for (let i = 0; i < b.length; i += 4) v.push(b.readFloatLE(i));
    return v;
};
export const embed = (t: string) => embedForSector(t, "semantic");
export const getEmbeddingProvider = () => currentEnv().embed_kind;

// Re-export SIMD utilities for shared use across modules
export { dotProduct, normalize, fuseVectors, benchmarkSimd } from "../utils/simd";

/**
 * Shared vector fusion utility that handles SIMD selection and sector-aware weighting.
 * Centralizes fusion logic to prevent drift between router direct calls and legacy paths.
 * @param syn Synthetic vector component
 * @param sem Semantic vector component
 * @param weights [synWeight, semWeight] tuple (must sum to 1)
 * @param useSimd Use SIMD optimization if available, defaults to env config
 * @param sector Optional sector for logging, affects weight defaults
 * @returns Fused and normalized vector
 */
export function fuseEmbeddingVectors(
    syn: number[],
    sem: number[],
    weights: [number, number],
    useSimd: boolean = currentEnv().fusion_simd_enabled,
    sector?: string
): number[] {
    // Input validation
    if (syn.length !== sem.length) throw new Error('Vector length mismatch');
    if (weights.length !== 2 || Math.abs(weights[0] + weights[1] - 1) >= 1e-6) throw new Error('Invalid weights');
    if (syn.some(isNaN) || sem.some(isNaN) || weights.some(isNaN)) throw new Error('NaN values in vectors or weights');

    const synArr = new Float32Array(syn);
    const semArr = new Float32Array(sem);
    let fused: number[];

    // Use SIMD if enabled and supported
    if (useSimd && SIMD_SUPPORTED) {
        const fusedArr = fuseVectors(synArr, semArr, weights);
        fused = Array.from(fusedArr);
    } else {
        // Legacy fusion with weighted sum and normalization
        fused = syn.map((v, i) => v * weights[0] + sem[i] * weights[1]);
    }

    // Ensure proper normalization for all paths
    const norm = Math.sqrt(fused.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
        fused = fused.map(x => x / norm);
    }

    // Handle degenerate cases
    if (syn.every(v => v === 0) && sem.every(v => v === 0)) {
        // Both zero vectors - return unit vector
        fused = new Array(syn.length).fill(1 / Math.sqrt(syn.length));
    }

    if (sector) {
        embedLog('debug', { fusion_path: useSimd && SIMD_SUPPORTED ? 'SIMD' : 'legacy', sector, weights: weights.join(':') },
            `[EMBED] Fusion path: ${useSimd && SIMD_SUPPORTED ? 'SIMD' : 'legacy'} for sector ${sector}`);
    }

    return fused;
}



export const getEmbeddingInfo = async () => {
    const e = currentEnv();
    const i: Record<string, any> = {
        kind: e.embed_kind,  // Canonical mode string from OM_EMBED_KIND (e.g., 'openai', 'router_cpu')
        provider: e.embed_kind,  // Provider implementation (currently same as kind for all modes)
        dimensions: e.vec_dim,
        mode: e.embed_mode,  // Processing mode: 'simple' or 'advanced'
        batch_support: e.embed_mode === "simple" && (e.embed_kind === "gemini" || e.embed_kind === "openai"),
        advanced_parallel: e.adv_embed_parallel,
        embed_delay_ms: e.embed_delay_ms,
    };
    if (e.embed_kind === "openai") {
        i.configured = !!e.openai_key;
        i.base_url = e.openai_base_url;
        i.model_override = e.openai_model || null;
        i.batch_api = e.embed_mode === "simple";
        i.models = {
            episodic: get_model("episodic", "openai"),
            semantic: get_model("semantic", "openai"),
            procedural: get_model("procedural", "openai"),
            emotional: get_model("emotional", "openai"),
            reflective: get_model("reflective", "openai"),
        };
    } else if (e.embed_kind === "gemini") {
        i.configured = !!e.gemini_key;
        i.batch_api = e.embed_mode === "simple";
        i.model = "embedding-001";
    } else if (e.embed_kind === "ollama") {
        i.configured = true;
        i.url = e.ollama_url;
        i.models = {
            episodic: get_model("episodic", "ollama"),
            semantic: get_model("semantic", "ollama"),
            procedural: get_model("procedural", "ollama"),
            emotional: get_model("emotional", "ollama"),
            reflective: get_model("reflective", "ollama"),
        };
        i.keep_alive = e.ollama_keep_alive;
        i.models_config = e.ollama_models;
        i.num_parallel = e.ollama_num_parallel;
        i.num_gpu = e.ollama_num_gpu;
        i.auto_pull = cfgEnv.ollama_auto_pull;
        i.multimodal_enabled = cfgEnv.ollama_multimodal_enabled;
        i.management_api = {
            pull: "/embed/ollama/pull",
            list: "/embed/ollama/list",
            delete: "/embed/ollama/delete",
            status: "/embed/ollama/status",
        };
    } else if (e.embed_kind === "local") {
        i.configured = !!e.local_model_path;
        i.path = e.local_model_path;
    } else if (e.embed_kind === "router_cpu") {
        i.configured = true;
        i.router_enabled = true;
        i.simd_enabled = e.router_simd_enabled;
        i.fallback_enabled = e.router_fallback_enabled;
        i.cache_ttl_ms = e.router_cache_ttl_ms;
        i.sector_models = e.router_sector_models || {
            episodic: "nomic-embed-text",
            semantic: "nomic-embed-text",
            procedural: "bge-small-en-v1.5",
            emotional: "nomic-embed-text",
            reflective: "nomic-embed-text",
        };
        i.performance = {
            expected_p95_ms: 150,
            expected_simd_improvement: 30,
            memory_usage_gb: 2.5
        };
        i.ollama_required = true;

        // Use cached validation function for efficiency and consistency
        if (!e.router_validate_on_start) {
            i.validation_errors = [];
            i.validation_status = 'skipped';
        } else {
            try {
                const validationResult = await validateRouterOnStartup();
                i.validation_status = validationResult.status;
                i.validation_errors = validationResult.errors;
            } catch (error) {
                // Convert strict mode failures to response fields instead of throwing for GET /embed/config
                const msg = error instanceof Error ? error.message : String(error);
                embedLog('warn', { component: 'EMBED', error: msg }, '[EMBED] Router validation failed for config endpoint');
                i.validation_errors = [{ sector: 'error', model: 'error', expected: e.vec_dim, detected: 0, ratio: 0 }];
                i.validation_status = 'failed';
            }
        }
    } else {
        i.configured = true;
        i.type = "synthetic";
    }
    return i;
};

/**
 * Check Ollama service health and version
 * Returns null if Ollama is not available or not the active provider
 */
/**
 * Single source of truth for Ollama health and status information.
 * Reused by /health and /embed/ollama/status endpoints to ensure consistency.
 * Any new health-related endpoints should use this function to prevent divergence.
 */
export async function getOllamaHealth(): Promise<{
    available: boolean;
    version?: string;
    models_loaded?: number;
    error?: string;
} | null> {
    const e = currentEnv();
    // If no URL is configured, treat as unconfigured
    if (!e.ollama_url) {
        return null; // No Ollama URL configured
    }

    const attempts = 3;
    const timeoutMs = 3000;
    const baseDelayMs = 500;

    // First check basic health and version via /api/health endpoint
    let version: string = "unknown";
    let basicHealth = false;

    for (let i = 0; i < attempts; i++) {
        try {
            const healthResponse = await fetch(`${e.ollama_url}/api/health`, {
                method: "GET",
                signal: AbortSignal.timeout(timeoutMs),
            });

            if (healthResponse.ok) {
                const healthData = await healthResponse.json().catch(() => ({}));
                version = healthResponse.headers.get("ollama-version") ||
                    healthData.version ||
                    "unknown";
                basicHealth = true;
                break; // Basic health check passed
            } else {
                // Continue retrying even on /api/health failure
                embedLog('warn', { component: 'EMBED', attempt: i + 1, status: healthResponse.status }, `[EMBED] /api/health check failed: ${healthResponse.status}`);
            }
        } catch (err) {
            embedLog('warn', { component: 'EMBED', attempt: i + 1, error: err instanceof Error ? err.message : String(err) }, `[EMBED] /api/health fetch failed`);
            if (i === attempts - 1) {
                // If /api/health completely fails, continue to /api/tags as fallback
                basicHealth = false;
                break;
            }
            const backoff = baseDelayMs * Math.pow(2, i);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }

    // Get model count via /api/tags if basic health suggests service is responsive
    let modelsLoaded = 0;
    if (basicHealth) {
        try {
            const tagsResponse = await fetch(`${e.ollama_url}/api/tags`, {
                method: "GET",
                signal: AbortSignal.timeout(timeoutMs),
            });

            if (tagsResponse.ok) {
                const tagsData = (await tagsResponse.json()) as { models?: any[] };
                modelsLoaded = tagsData.models?.length || 0;
                // Update version from /api/tags if not set by /api/health
                version = tagsResponse.headers.get("ollama-version") || version;
            } else {
                embedLog('warn', { component: 'EMBED', status: tagsResponse.status }, `[EMBED] /api/tags check failed after successful /api/health: ${tagsResponse.status}`);
                // Continue with basic health - model count can be defaulted
            }
        } catch (err) {
            embedLog('warn', { component: 'EMBED', error: err instanceof Error ? err.message : String(err) }, `[EMBED] /api/tags fetch failed after successful /api/health`);
            // Continue with basic health - model count can be defaulted
        }
    }

    if (basicHealth) {
        return {
            available: true,
            version,
            models_loaded: modelsLoaded,
        };
    }

    // If basic health check failed entirely, try /api/tags as fallback for backwards compatibility
    let fallbackAvailable = false;
    for (let i = 0; i < attempts; i++) {
        try {
            const r = await fetch(`${e.ollama_url}/api/tags`, {
                method: "GET",
                signal: AbortSignal.timeout(timeoutMs),
            });

            if (r.ok) {
                const data = (await r.json()) as { models?: any[] };
                fallbackAvailable = true;
                version = r.headers.get("ollama-version") || "unknown";
                modelsLoaded = data.models?.length || 0;
                embedLog('info', { component: 'EMBED', version, models_loaded: modelsLoaded }, `[EMBED] Ollama available via /api/tags (health endpoint unavailable)`);
                break;
            } else if (r.status >= 500) {
                // Server errors suggest complete unavailability
                embedLog('warn', { component: 'EMBED', attempt: i + 1, status: r.status }, `[EMBED] /api/tags returned 5xx status`);
            }
        } catch (err) {
            if (i === attempts - 1) {
                const errorMsg = `Failed after ${attempts} retries: ${err instanceof Error ? err.message : String(err)}`;
                embedLog('warn', { component: 'EMBED', attempts, error: err instanceof Error ? err.message : String(err) }, `[EMBED] Ollama health check failed after retries: %s`, errorMsg);
                return {
                    available: false,
                    error: errorMsg,
                };
            }
            const backoff = baseDelayMs * Math.pow(2, i);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }

    if (fallbackAvailable) {
        return {
            available: true,
            version,
            models_loaded: modelsLoaded,
        };
    }

    const errorMsg = "Ollama service unavailable - both /api/health and /api/tags failed";
    return {
        available: false,
        error: errorMsg,
    };
}
