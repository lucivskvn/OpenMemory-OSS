/**
 * @file Multi-provider embedding logic for OpenMemory.
 * Handles semantic vector generation with robust fallback chains and batching support.
 */
import { env, tier } from "../core/cfg";
import { q } from "../core/db";
import { sectorConfigs } from "../core/hsg_config";
import { getModel } from "../core/models";
import { normalizeUserId, retry } from "../utils";
import { addSynonymTokens, canonicalTokensFromText } from "../utils/text";
import {
    aggregateVectors,
    bufferToVector,
    cosineSimilarity,
    vectorToBuffer,
} from "../utils/vectors";
export { aggregateVectors, bufferToVector, cosineSimilarity, vectorToBuffer };
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { env as hfEnv, pipeline } from "@huggingface/transformers";
import OpenAI from "openai";

import { logger } from "../utils/logger";

// Basic typing for HF pipeline functionality
type FeatureExtractor = (text: string | string[], options?: { pooling?: string; normalize?: boolean }) => Promise<{ data: Float32Array | number[] }>;

let extractor: FeatureExtractor | null = null;
/**
 * Initializes and caches the local embedding model extractor.
 * Configures ONNX Runtime with hardware acceleration and thread limits for resource-constrained environments.
 * 
 * @returns {Promise<any>} The Transformers.js pipeline instance.
 */
const getExtractor = async () => {
    if (!extractor) {
        if (env.verbose)
            logger.info(
                `[EMBED] Initializing local embedding model: ${env.localEmbeddingModel} (Device: ${env.localEmbeddingDevice}, Threads: ${env.localEmbeddingThreads})`,
            );

        /**
         * Configure ONNX Runtime for CPU-only or restricted core environments (Sustainability).
         * Note: hfEnv.backends might be used in some versions, but hfEnv.onnx is common.
         * Using type assertion to bypass environment-specific type detection.
         */
        try {
            // @ts-expect-error - Transformers.js v3 env properties
            hfEnv.onnx = hfEnv.onnx || {};
            // @ts-expect-error - Transformers.js v3 type workaround
            hfEnv.onnx.numThreads = env.localEmbeddingThreads;
        } catch (e) {
            logger.warn("[EMBED] Failed to configure ONNX thread limits:", { error: e });
        }

        extractor = (await pipeline(
            "feature-extraction",
            env.localEmbeddingModel,
            {
                device: env.localEmbeddingDevice === "auto" ? undefined : env.localEmbeddingDevice,
            }
        )) as any;
    }
    return extractor;
};

let gemQ: Promise<void> = Promise.resolve();
export const embDim = () => env.vecDim;

// Fetch with timeout to prevent hanging requests and enable fallback chain
const EMBED_TIMEOUT_MS = env.embedTimeoutMs;
async function fetchWithTimeout(
    url: string,
    options: RequestInit,
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

export interface EmbeddingResult {
    sector: string;
    vector: number[];
    dim: number;
}

const compressVec = (v: number[], td: number): number[] => {
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

const fuseVecs = (syn: number[], sem: number[]): number[] => {
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
    if (env.verbose)
        logger.debug(
            `[EMBED] Provider: ${env.embKind}, Tier: ${tier}, Sector: ${s}`,
        );
    if (!sectorConfigs[s]) throw new Error(`Unknown sector: ${s}`);
    if (tier === "hybrid") return genSynEmb(t, s);
    if (tier === "smart" && env.embKind !== "synthetic") {
        const syn = genSynEmb(t, s),
            sem = await getSemEmb(t, s),
            comp = compressVec(sem, 128);
        return fuseVecs(syn, comp);
    }
    if (tier === "fast") return genSynEmb(t, s);
    return await getSemEmb(t, s);
}

/**
 * Batch embed query text for ALL sectors in one API call.
 * This significantly improves query performance by reducing 5 sequential
 * API calls to a single batched call (~4.5x faster for deep tier).
 */
export async function embedQueryForAllSectors(
    query: string,
    sectors: string[],
): Promise<EmbeddingResult[]> {
    // For hybrid/fast tiers, use synthetic embeddings (already fast)
    if (tier === "hybrid" || tier === "fast") {
        return sectors.map((s) => ({
            sector: s,
            vector: genSynEmb(query, s),
            dim: env.vecDim || 768,
        }));
    }

    // Use the robust batch fallback mechanism to ensure both speed and reliability
    try {
        const tb: Record<string, string> = {};
        for (const s of sectors) tb[s] = query;
        const resMap = await embBatchWithFallback(tb);
        return Object.entries(resMap).map(([s, v]) => ({
            sector: s,
            vector: v,
            dim: v.length,
        }));
    } catch (e) {
        logger.error(
            "[EMBED] Batch query embedding failed, using sequential fallback:",
            { error: e },
        );
    }

    // Fallback: sequential embedding for each sector
    const result: EmbeddingResult[] = [];
    for (const s of sectors) {
        const v = await embedForSector(query, s);
        result.push({ sector: s, vector: v, dim: v.length });
    }
    return result;
}

// Embed with a specific provider (throws on failure)
async function embedWithProvider(
    provider: string,
    t: string,
    s: string,
): Promise<number[]> {
    switch (provider) {
        case "openai":
            return await embOpenAI(t, s);
        case "gemini":
            return (await embGemini({ [s]: t }))[s];
        case "ollama":
            return await embOllama(t, s);
        case "aws":
            return await embAWS(t, s);
        case "local":
            return await embLocal(t, s);
        case "synthetic":
            return genSynEmb(t, s);
        default:
            throw new Error(`Unknown embedding provider: ${provider}`);
    }
}

// Get semantic embedding with configurable fallback chain
async function getSemEmb(t: string, s: string): Promise<number[]> {
    // Deduplicate providers to avoid wasteful retries (e.g., gemini,gemini,synthetic)
    const providers = [...new Set([env.embKind, ...env.embeddingFallback])];

    for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        try {
            const result = await retry(
                () => embedWithProvider(provider, t, s),
                {
                    retries: env.maxRetries,
                    delay: 500,
                    onRetry: (e, att) =>
                        logger.warn(
                            `[EMBED] ${provider} retry ${att}/${env.maxRetries}:`,
                            { error: e },
                        ),
                },
            );
            if (i > 0) {
                logger.info(
                    `[EMBED] Fallback to ${provider} succeeded for sector: ${s}`,
                );
            }
            return result;
        } catch (e) {
            // const _errMsg = e instanceof Error ? e.message : String(e);
            const nextProvider = providers[i + 1];

            if (nextProvider) {
                logger.error(
                    `[EMBED] ${provider} failed after retries, trying ${nextProvider}:`,
                    { error: e },
                );
            } else {
                logger.error(
                    `[EMBED] All providers failed. Last error (${provider}), using synthetic:`,
                    { error: e },
                );
                return genSynEmb(t, s);
            }
        }
    }
    // Fallback if providers array is empty (shouldn't happen with defaults)
    return genSynEmb(t, s);
}

// Batch embedding with fallback chain support (for simple mode)
async function embBatchWithFallback(
    txts: Record<string, string>,
): Promise<Record<string, number[]>> {
    const providers = [...new Set([env.embKind, ...env.embeddingFallback])];

    for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        try {
            let result: Record<string, number[]>;
            switch (provider) {
                case "gemini":
                    // Use Gemini batch function
                    // Note: embGemini assumes env.geminiKey is set
                    result = await embGemini(txts);
                    break;
                case "openai":
                    // Use OpenAI batch function
                    result = await embBatchOpenAI(txts);
                    break;
                case "ollama":
                    // Use Ollama batch function
                    result = await embBatchOllama(txts, null); // Global context for now in simple batch
                    break;
                default: {
                    // For providers without batch support, embed each sector individually
                    // We must wait for all promises
                    result = {};
                    const entries = Object.entries(txts);
                    // Process in parallel or serial depending on support?
                    // Let's do serial for safety as default fallback often implies reliability > speed
                    for (const [s, t] of entries) {
                        result[s] = await embedWithProvider(provider, t, s);
                    }
                    break;
                }
            }
            if (i > 0) {
                logger.info(
                    `[EMBED] Fallback to ${provider} succeeded for batch`,
                );
            }
            return result;
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);

            // Log fallback attempt
            const nextProvider = providers[i + 1];

            if (nextProvider) {
                logger.error(
                    `[EMBED] ${provider} batch failed: ${errMsg}, trying ${nextProvider}`,
                );
            } else {
                logger.error(
                    `[EMBED] All providers failed for batch. Last error (${provider}): ${errMsg}. Using synthetic.`,
                );
                // Fall back to synthetic for all sectors
                const result: Record<string, number[]> = {};
                for (const [s, t] of Object.entries(txts)) {
                    result[s] = genSynEmb(t, s);
                }
                return result;
            }
        }
    }
    // Fallback if providers array is empty (should not happen if synthetic is default)
    const result: Record<string, number[]> = {};
    for (const [s, t] of Object.entries(txts)) {
        result[s] = genSynEmb(t, s);
    }
    return result;
}

interface GeminiEmbeddingResponse {
    embeddings: Array<{ values: number[] }>;
}

interface OllamaEmbeddingResponse {
    embedding: number[];
}

async function embOpenAI(t: string, s: string): Promise<number[]> {
    if (!env.openaiKey) throw new Error("OpenAI key missing");
    const m = getModel(s, "openai");
    const openai = new OpenAI({
        apiKey: env.openaiKey,
        baseURL: env.openaiBaseUrl || undefined,
        timeout: EMBED_TIMEOUT_MS,
    });

    // Check if model supports dimensions (v3 only)
    const isV3 = (env.openaiModel || m).includes("text-embedding-3");
    const params: OpenAI.Embeddings.EmbeddingCreateParams = {
        input: t,
        model: env.openaiModel || m,
    };
    if (isV3 && env.vecDim) params.dimensions = env.vecDim;

    const response = await openai.embeddings.create(params);
    return response.data[0].embedding;
}

async function embBatchOpenAI(
    txts: Record<string, string>,
): Promise<Record<string, number[]>> {
    const apiKey = env.openaiKey;
    if (!apiKey) throw new Error("OpenAI key missing");
    const secs = Object.keys(txts);
    const m = getModel("semantic", "openai");
    const openai = new OpenAI({
        apiKey,
        baseURL: env.openaiBaseUrl || undefined,
        timeout: EMBED_TIMEOUT_MS,
    });

    const isV3 = (env.openaiModel || m).includes("text-embedding-3");
    const params: OpenAI.Embeddings.EmbeddingCreateParams = {
        input: Object.values(txts),
        model: env.openaiModel || m,
    };
    if (isV3 && env.vecDim) params.dimensions = env.vecDim;

    const response = await openai.embeddings.create(params);
    const out: Record<string, number[]> = {};
    secs.forEach((s, i) => (out[s] = response.data[i].embedding));
    return out;
}

const taskMap: Record<string, string> = {
    episodic: "RETRIEVAL_DOCUMENT",
    semantic: "SEMANTIC_SIMILARITY",
    procedural: "RETRIEVAL_DOCUMENT",
    emotional: "CLASSIFICATION",
    reflective: "SEMANTIC_SIMILARITY",
};

async function embGemini(
    txts: Record<string, string>,
): Promise<Record<string, number[]>> {
    if (!env.geminiKey) throw new Error("Gemini key missing");
    const prom = gemQ.then(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${env.geminiKey}`;
        for (let a = 0; a < 3; a++) {
            try {
                const reqs = Object.entries(txts).map(([s, t]) => {
                    const m = getModel(s, "gemini");
                    return {
                        model: m.startsWith("models/") ? m : `models/${m}`,
                        content: { parts: [{ text: t }] },
                        taskType: taskMap[s] || taskMap.semantic,
                    };
                });
                const r = await fetchWithTimeout(url, {
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
                        logger.warn(
                            `[EMBED] Gemini rate limit (${a + 1}/3), waiting ${d}ms`,
                        );
                        if (typeof Bun !== "undefined" && Bun.sleep) {
                            await Bun.sleep(d);
                        } else {
                            await new Promise((x) => setTimeout(x, d));
                        }
                        continue;
                    }
                    throw new Error(`Gemini: ${r.status}`);
                }
                const data = (await r.json()) as GeminiEmbeddingResponse;
                const out: Record<string, number[]> = {};
                let i = 0;
                for (const s of Object.keys(txts))
                    out[s] = resizeVec(data.embeddings[i++].values, env.vecDim);
                await Bun.sleep(1500);
                return out;
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                if (a === 2) {
                    throw new Error(
                        `Gemini failed after 3 attempts: ${errMsg}`,
                    );
                }
                logger.error(`[EMBED] Gemini error (${a + 1}/3):`, {
                    error: e,
                });
                await Bun.sleep(1000 * Math.pow(2, a));
            }
        }
        throw new Error("Gemini: exhausted retries");
    });
    gemQ = prom.then(() => { }).catch(() => { });
    return prom;
}

/**
 * Resolves the best Ollama model for a given scenario.
 * Automates selection based on text length and sector.
 */
async function resolveOllamaModel(t: string, s: string, userId?: string | null): Promise<string> {
    // 1. Try Persistent Config (populated by discovery or manually)
    const { getPersistedConfig } = await import("../core/persisted_cfg");
    const pConfig = await getPersistedConfig<Record<string, string>>(normalizeUserId(userId) || null, "ollama_embeddings");

    // 2. Try Env Config (OM_OLLAMA_EMBED_MODELS)
    const eConfig = env.ollamaEmbedModels as Record<string, string>;

    const config = { ...eConfig, ...pConfig };

    // A. Sector-specific override from config
    if (config[s]) return config[s];

    // B. Scenario automation (Length-based)
    const isLong = t.length > 2000;
    if (isLong && config.large) return config.large;
    if (!isLong && config.fast) return config.fast;

    // C. Fallback to default
    return getModel(s, "ollama");
}

async function embOllama(t: string, s: string, userId?: string | null): Promise<number[]> {
    const m = await resolveOllamaModel(t, s, userId);
    // Use the newer /api/embed endpoint which is more robust and supports options
    const r = await fetchWithTimeout(`${env.ollamaUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: m,
            input: t,
            options: {
                num_gpu: env.ollamaNumGpu
            }
        }),
    });

    if (!r.ok) {
        // Fallback to legacy /api/embeddings if /api/embed fails
        if (r.status === 404) {
            const r2 = await fetchWithTimeout(`${env.ollamaUrl}/api/embeddings`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: m, prompt: t }),
            });
            if (!r2.ok) throw new Error(`Ollama legacy: ${r2.status}`);
            const data = (await r2.json()) as OllamaEmbeddingResponse;
            return resizeVec(data.embedding, env.vecDim);
        }
        throw new Error(`Ollama: ${r.status}`);
    }
    const data = (await r.json()) as { embeddings: number[][] };
    return resizeVec(data.embeddings[0], env.vecDim);
}

async function embBatchOllama(
    txts: Record<string, string>,
    userId?: string | null,
): Promise<Record<string, number[]>> {
    const secs = Object.keys(txts);
    const inputs = Object.values(txts);
    // Use first sector to resolve model (assuming homogeneous batch for now)
    const m = await resolveOllamaModel(inputs[0], secs[0], userId);

    const r = await fetchWithTimeout(`${env.ollamaUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: m,
            input: inputs,
            options: {
                num_gpu: env.ollamaNumGpu
            }
        }),
    });

    if (!r.ok) throw new Error(`Ollama Batch: ${r.status}`);
    const data = (await r.json()) as { embeddings: number[][] };

    const out: Record<string, number[]> = {};
    secs.forEach((s, i) => (out[s] = resizeVec(data.embeddings[i], env.vecDim)));
    return out;
}

async function embAWS(t: string, s: string): Promise<number[]> {
    if (!env.awsRegion) throw new Error("AWS region missing");
    if (!env.awsAccessKeyId) throw new Error("AWS access key ID missing");
    if (!env.awsSecretAccessKey)
        throw new Error("AWS secret access key missing");

    const m = getModel(s, "aws");
    const client = new BedrockRuntimeClient({
        region: env.awsRegion,
        credentials: {
            accessKeyId: env.awsAccessKeyId,
            secretAccessKey: env.awsSecretAccessKey,
        },
    });
    const dim = [256, 512, 1024].find((x) => x >= env.vecDim) ?? 1024;
    const params = {
        modelId: m,
        contentType: "application/json",
        accept: "*/*",
        body: JSON.stringify({
            inputText: t,
            dimensions: dim,
        }),
    };
    const command = new InvokeModelCommand(params);

    try {
        const response = await client.send(command);
        const jsonString = new TextDecoder().decode(response.body);
        const parsedResponse = JSON.parse(jsonString);
        return resizeVec(parsedResponse.embedding, env.vecDim);
    } catch (error) {
        throw new Error(
            `AWS error: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function embLocal(t: string, s: string): Promise<number[]> {
    try {
        const pipe = await getExtractor();
        if (!pipe) throw new Error("Local model not initialized");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const output = await pipe(t, { pooling: "mean", normalize: true } as any);
        const v = Array.from(output.data as Float32Array);

        if (env.localEmbeddingResize) {
            return resizeVec(v, env.vecDim);
        }
        return v;
    } catch (e) {
        logger.error(
            `[EMBED] Local embedding (${env.localEmbeddingModel}) failed, using synthetic:`,
            { error: e },
        );
        return genSynEmb(t, s);
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
const addFeat = (vec: Float32Array, dim: number, k: string, w: number) => {
    const h = h1(k),
        h2Val = h2(k, 0xdeadbeef),
        val = w * (1 - ((h & 1) << 1));
    if (dim > 0 && (dim & (dim - 1)) === 0) {
        vec[h & (dim - 1)] += val;
        vec[h2Val & (dim - 1)] += val * 0.5;
    } else {
        vec[h % dim] += val;
        vec[h2Val % dim] += val * 0.5;
    }
};
const addPosFeat = (vec: Float32Array, dim: number, pos: number, w: number) => {
    const idx = pos % dim,
        ang = pos / Math.pow(10000, (2 * idx) / dim);
    vec[idx] += w * Math.sin(ang);
    vec[(idx + 1) % dim] += w * Math.cos(ang);
};
const secWts: Record<string, number> = {
    episodic: 1.3,
    semantic: 1.0,
    procedural: 1.2,
    emotional: 1.4,
    reflective: 0.9,
};
const normV = (v: Float32Array) => {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    if (n === 0) return;
    const inv = 1 / Math.sqrt(n);
    for (let i = 0; i < v.length; i++) v[i] *= inv;
};

export function genSynEmb(t: string, s: string): number[] {
    const d = env.vecDim || 768,
        v = new Float32Array(d).fill(0);
    const ct = canonicalTokensFromText(t);
    if (!ct.length) {
        const x = 1 / Math.sqrt(d);
        return Array.from({ length: d }, () => x);
    }
    const et = Array.from(addSynonymTokens(ct)),
        tc = new Map<string, number>(),
        el = et.length;
    for (let i = 0; i < el; i++) {
        const tok = et[i];
        tc.set(tok, (tc.get(tok) || 0) + 1);
    }
    const sw = secWts[s] || 1.0,
        dl = Math.log(1 + el);
    for (const [tok, c] of tc) {
        const tf = c / el,
            idf = Math.log(1 + el / c),
            w = (tf * idf + 1) * sw;
        addFeat(v, d, `${s}|tok|${tok}`, w);
        if (tok.length >= 3)
            for (let i = 0; i < tok.length - 2; i++)
                addFeat(v, d, `${s}|c3|${tok.slice(i, i + 3)}`, w * 0.4);
        if (tok.length >= 4)
            for (let i = 0; i < tok.length - 3; i++)
                addFeat(v, d, `${s}|c4|${tok.slice(i, i + 4)}`, w * 0.3);
    }
    for (let i = 0; i < ct.length - 1; i++) {
        const a = ct[i],
            b = ct[i + 1];
        if (a && b) {
            const pw = 1.0 / (1.0 + i * 0.1);
            addFeat(v, d, `${s}|bi|${a}_${b}`, 1.4 * sw * pw);
        }
    }
    for (let i = 0; i < ct.length - 2; i++) {
        const a = ct[i],
            b = ct[i + 1],
            c = ct[i + 2];
        if (a && b && c) addFeat(v, d, `${s}|tri|${a}_${b}_${c}`, 1.0 * sw);
    }
    for (let i = 0; i < Math.min(ct.length - 2, 20); i++) {
        const a = ct[i],
            c = ct[i + 2];
        if (a && c) addFeat(v, d, `${s}|skip|${a}_${c}`, 0.7 * sw);
    }
    for (let i = 0; i < Math.min(ct.length, 50); i++)
        addPosFeat(v, d, i, (0.5 * sw) / dl);
    const lb = Math.min(Math.floor(Math.log2(el + 1)), 10);
    addFeat(v, d, `${s}|len|${lb}`, 0.6 * sw);
    const dens = tc.size / el,
        db = Math.floor(dens * 10);
    addFeat(v, d, `${s}|dens|${db}`, 0.5 * sw);
    normV(v);
    return Array.from(v);
}

const resizeVec = (v: number[], t: number) => {
    if (v.length === t) return v;
    if (v.length > t) return v.slice(0, t);
    return [...v, ...Array(t - v.length).fill(0)];
};

const CACHE = new Map<string, { val: EmbeddingResult[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_SIZE = 500;

/**
 * Generates embeddings for multiple sectors with concurrency control and hardware awareness.
 * 
 * @param txt - The text to embed.
 * @param sectors - List of sectors (aspects) to analyze.
 * @param userId - Optional user context for model selection.
 * @returns {Promise<EmbeddingResult[]>} Array of sector-specific vectors.
 */
export async function embedMultiSector(
    id: string,
    txt: string,
    secs: string[],
    chunks?: Array<{ text: string }>,
    userId?: string | null,
): Promise<EmbeddingResult[]> {
    const uid = normalizeUserId(userId);
    // Cache Check (only if no chunks, as chunks complicate cache keys)
    if ((!chunks || chunks.length <= 1) && CACHE.has(txt)) {
        const c = CACHE.get(txt)!;
        if (Date.now() - c.ts < CACHE_TTL) {
            // LRU: Refresh position
            CACHE.delete(txt);
            CACHE.set(txt, c);
            return c.val;
        } else {
            CACHE.delete(txt); // Expired
        }
    }

    const r: EmbeddingResult[] = [];
    await q.insLog.run(id, uid, "multi-sector", "pending", Date.now(), null);
    for (let a = 0; a < 3; a++) {
        try {
            const simp = env.embedMode === "simple";
            if (
                simp &&
                (env.embKind === "gemini" || env.embKind === "openai")
            ) {
                if (env.verbose) {
                    logger.debug(
                        `[EMBED] Simple mode (1 batch for ${secs.length} sectors)`,
                    );
                }
                const tb: Record<string, string> = {};
                secs.forEach((s) => (tb[s] = txt));
                // Use batch embedding with fallback support
                const b = await embBatchWithFallback(tb);
                Object.entries(b).forEach(([s, v]) =>
                    r.push({ sector: s, vector: v, dim: v.length }),
                );
            } else {
                if (env.verbose)
                    logger.debug(
                        `[EMBED] Advanced mode (${secs.length} calls)`,
                    );
                const par = env.advEmbedParallel && env.embKind !== "gemini";
                if (par) {
                    const CONCURRENCY = env.localEmbeddingDevice === "cpu" ? 2 : 4;
                    const results: EmbeddingResult[] = [];
                    for (let i = 0; i < secs.length; i += CONCURRENCY) {
                        const batch = secs.slice(i, i + CONCURRENCY);
                        const p = batch.map(async (s) => {
                            let v: number[];
                            if (chunks && chunks.length > 1) {
                                const cv: number[][] = [];
                                for (const c of chunks)
                                    cv.push(await embedForSector(c.text, s));
                                v = aggregateVectors(cv);
                            } else v = await embedForSector(txt, s);
                            return { sector: s, vector: v, dim: v.length };
                        });
                        results.push(...(await Promise.all(p)));
                    }
                    r.push(...results);
                } else {
                    for (let i = 0; i < secs.length; i++) {
                        const s = secs[i];
                        let v: number[];
                        if (chunks && chunks.length > 1) {
                            const cv: number[][] = [];
                            for (const c of chunks)
                                cv.push(await embedForSector(c.text, s));
                            v = aggregateVectors(cv);
                        } else v = await embedForSector(txt, s);
                        r.push({ sector: s, vector: v, dim: v.length });
                        if (env.embedDelayMs > 0 && i < secs.length - 1)
                            await Bun.sleep(env.embedDelayMs);
                    }
                }
            }
            await q.updLog.run(id, "completed", null);

            // Update Cache
            if ((!chunks || chunks.length <= 1) && r.length > 0) {
                if (CACHE.size >= CACHE_SIZE) {
                    const first = CACHE.keys().next().value;
                    if (first) CACHE.delete(first);
                }
                CACHE.set(txt, { val: r, ts: Date.now() });
            }

            return r;
        } catch (e) {
            if (a === 2) {
                await q.updLog.run(
                    id,
                    "failed",
                    e instanceof Error ? e.message : String(e),
                );
                throw e;
            }
            await Bun.sleep(1000 * Math.pow(2, a));
        }
    }
    throw new Error("Embedding failed after retries");
}

// aggregateVectors imported from src/utils/vectors.ts

export const embed = (t: string) => embedForSector(t, "semantic");
export const getEmbeddingProvider = () => env.embKind;

export const getEmbeddingInfo = () => {
    const i: Record<string, unknown> = {
        provider: env.embKind,
        fallbackChain: env.embeddingFallback,
        dimensions: env.vecDim,
        mode: env.embedMode,
        batchSupport:
            env.embedMode === "simple" &&
            (env.embKind === "gemini" || env.embKind === "openai"),
        advancedParallel: env.advEmbedParallel,
        embedDelayMs: env.embedDelayMs,
    };
    if (env.embKind === "openai") {
        i.configured = !!env.openaiKey;
        i.baseUrl = env.openaiBaseUrl;
        i.modelOverride = env.openaiModel || null;
        i.batchApi = env.embedMode === "simple";
        i.models = {
            episodic: getModel("episodic", "openai"),
            semantic: getModel("semantic", "openai"),
            procedural: getModel("procedural", "openai"),
            emotional: getModel("emotional", "openai"),
            reflective: getModel("reflective", "openai"),
        };
    } else if (env.embKind === "gemini") {
        i.configured = !!env.geminiKey;
        i.batchApi = env.embedMode === "simple";
        i.model = env.geminiModel || "models/text-embedding-004";
        i.models = {
            episodic: getModel("episodic", "gemini"),
            semantic: getModel("semantic", "gemini"),
            procedural: getModel("procedural", "gemini"),
            emotional: getModel("emotional", "gemini"),
            reflective: getModel("reflective", "gemini"),
        };
    } else if (env.embKind === "aws") {
        i.configured =
            !!env.awsRegion && !!env.awsAccessKeyId && !!env.awsSecretAccessKey;
        i.batchApi = env.embedMode === "simple";
        i.model = "amazon.titan-embed-text-v2:0";
    } else if (env.embKind === "ollama") {
        i.configured = true;
        i.url = env.ollamaUrl;
        i.models = {
            episodic: getModel("episodic", "ollama"),
            semantic: getModel("semantic", "ollama"),
            procedural: getModel("procedural", "ollama"),
            emotional: getModel("emotional", "ollama"),
            reflective: getModel("reflective", "ollama"),
        };
    } else if (env.embKind === "local") {
        i.configured = !!env.localModelPath;
        i.path = env.localModelPath;
    } else {
        i.configured = true;
        i.type = "synthetic";
    }
    return i;
};
