/**
 * @file decay.ts
 * @description Implements the memory decay and reinforcement loop (Memory Stability).
 * Uses exponential decay based on time and salience, with vector compression for "fading" memories.
 */

import { env } from "../core/cfg";
import { allAsync, memoriesTable, q, vectorStore } from "../core/db";
import { sectorConfigs } from "../core/hsg_config";
import { getEncryption } from "../core/security";
import { MemoryRow } from "../core/types";
import { normalizeUserId } from "../utils";
import { logger } from "../utils/logger";

// Subset of MemoryRow required for decay processing
type DecayingMemory = Pick<
    MemoryRow,
    | "id"
    | "content"
    | "salience"
    | "lastSeenAt"
    | "updatedAt"
    | "primarySector"
    | "userId"
    | "decayLambda"
> & {
    coactivations?: number;
    summary?: string;
};

// Configuration derived strictly from central env
const cfg = {
    threads: env.decayThreads,
    coldThreshold: env.decayColdThreshold,
    reinforceOnQuery: env.decayReinforceOnQuery,
    regenerationEnabled: env.regenerationEnabled,
    maxVecDim: env.maxVectorDim,
    minVecDim: env.minVectorDim,
    summaryLayers: env.summaryLayers,
    lambdaHot: 0.005,
    lambdaWarm: 0.02,
    lambdaCold: 0.05,
    timeUnitMs: 86_400_000, // 1 day in ms
};

// --- Math Helpers ---

const clampF = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const clampI = (v: number, a: number, b: number) =>
    Math.min(b, Math.max(a, Math.floor(v)));
const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mean = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const l2 = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const normalize = (v: number[]) => {
    const n = l2(v) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
};

const chunkz = <T>(arr: T[], k: number) => {
    const n = Math.max(1, k | 0);
    const out: T[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < arr.length; i++) out[i % n].push(arr[i]);
    return out;
};

// --- State ---

let activeQ = 0;
let lastDecay = 0;
const cooldown = 60000;

export const incQ = () => activeQ++;
export const decQ = () => activeQ--;

// --- Logic ---

const pickTier = (
    m: DecayingMemory,
    nowTs: number,
): "hot" | "warm" | "cold" => {
    const last = m.lastSeenAt || m.updatedAt || nowTs;
    const dt = Math.max(0, nowTs - last);
    const recent = dt < 6 * 86_400_000; // 6 days
    const high = (m.coactivations || 0) > 5 || (m.salience || 0) > 0.7;

    if (recent && high) return "hot";
    if (recent || (m.salience || 0) > 0.4) return "warm";
    return "cold";
};

/**
 * Compresses a vector by pooling/averaging dimensions.
 */
const compressVector = (
    vec: number[],
    f: number,
    minDim = 64,
    maxDim = 1536,
): number[] => {
    const src = vec.length ? vec : [1];
    const tgtDim = Math.max(
        minDim,
        Math.min(maxDim, Math.floor(src.length * clampF(f, 0.0, 1.0))),
    );

    if (tgtDim >= src.length) return src.slice(0); // No compression needed

    const dim = Math.max(minDim, Math.min(src.length, tgtDim));
    const pooled: number[] = [];
    const bucket = Math.ceil(src.length / dim);

    for (let i = 0; i < src.length; i += bucket) {
        pooled.push(mean(src.slice(i, i + bucket)));
    }
    normalize(pooled);
    return pooled;
};

import { calculateDualPhaseDecayMemoryRetention } from "../ops/dynamics";

export function calcDecay(
    sector: string,
    salience: number,
    timeDeltaMs: number,
): number {
    const days = timeDeltaMs / 86400000;
    const lambda = (sectorConfigs as any)[sector]?.decayLambda || 0.05;
    return calculateDualPhaseDecayMemoryRetention(salience, days, lambda);
}


export function calcReinforcedSalience(
    salience: number,
    boost: number = 0.1,
): number {
    return Math.min(1.0, salience + boost);
}

/**
 * Summarizes text based on forgetting factor 'f'.
 */
const compressSummary = (txt: string, f: number, layers = 3): string => {
    const t = (txt || "").trim();
    if (!t) return "";

    const lay = clampI(layers, 1, 3);
    const trunc = (s: string, n: number) =>
        s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
    const sumz = (s: string) => summarizeQuick(s);
    const keys = (s: string, k = 5) => topKeywords(s, k).join(" ");

    if (f > 0.8) return trunc(t, 200);
    if (f > 0.4) return trunc(sumz(t), lay >= 2 ? 80 : 200);
    return keys(t, lay >= 3 ? 5 : 3);
};

const fingerprintMem = (
    m: DecayingMemory,
    decryptedContent: string,
): { vector: number[]; summary: string } => {
    const base = (m.id + "|" + (m.summary || decryptedContent || "")).trim();
    const vec = hashToVec(base, 32);
    normalize(vec);
    const summary = topKeywords(m.summary || decryptedContent || "", 3).join(
        " ",
    );
    return { vector: vec, summary };
};

// SimHash-like deterministic vector generation
const hashToVec = (s: string, d = 32): number[] => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    const out: number[] = new Array(Math.max(2, d | 0)).fill(0);
    let x = h || 1;
    for (let i = 0; i < out.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[i] = ((x >>> 0) / 0xffffffff) * 2 - 1;
    }
    normalize(out);
    return out;
};

// Simple summarizer (first N important sentences)
const summarizeQuick = (t: string): string => {
    const sents = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (!sents.length) return t;

    const score = (s: string) =>
        topKeywords(s, 6).length + Math.min(3, s.match(/[,;:]/g)?.length || 0);

    const top = sents
        .map((s, i) => ({ s, i, sc: score(s) }))
        .sort((a, b) => b.sc - a.sc || a.i - b.i)
        .slice(0, Math.min(3, Math.ceil(sents.length / 3)))
        .sort((a, b) => a.i - b.i)
        .map((x) => x.s)
        .join(" ");

    return top || sents[0];
};

const stop = new Set([
    "the",
    "a",
    "an",
    "to",
    "of",
    "and",
    "or",
    "in",
    "on",
    "for",
    "with",
    "at",
    "by",
    "is",
    "it",
    "be",
    "as",
    "are",
    "was",
    "were",
    "from",
    "that",
    "this",
    "these",
    "those",
    "but",
    "if",
    "then",
    "so",
    "than",
    "into",
    "over",
    "under",
    "about",
    "via",
    "vs",
    "not",
]);

const topKeywords = (t: string, k = 5): string[] => {
    const words = (t.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
        (w) => !stop.has(w),
    );
    if (!words.length) return [];

    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);

    return Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, k)
        .map(([w]) => w);
};

// --- Main Process ---

export const applyDecay = async (
    userId: string | null | undefined = undefined,
): Promise<{ decayed: number; processed: number }> => {
    const uid = userId === undefined ? undefined : normalizeUserId(userId);
    if (activeQ > 0) {
        if (env.verbose)
            logger.info(`[DECAY] skipped - ${activeQ} active queries`);
        return { decayed: 0, processed: 0 };
    }

    const now = Date.now();
    if (now - lastDecay < cooldown) {
        if (env.verbose)
            logger.info(
                `[DECAY] skipped - cooldown active (${((cooldown - (now - lastDecay)) / 1000).toFixed(0)}s remaining)`,
            );
        return { decayed: 0, processed: 0 };
    }

    lastDecay = now;
    const t0 = performance.now();

    const segments = await q.getSegments.all();
    if (!segments || segments.length === 0) return { decayed: 0, processed: 0 };

    let totProc = 0,
        totChg = 0,
        totComp = 0,
        totFp = 0;
    const tierCounts = { hot: 0, warm: 0, cold: 0 };

    for (const seg of segments) {
        const segment = seg.segment;
        let userFilter = "";
        const queryParams: (string | number | null)[] = [segment];
        if (uid !== undefined) {
            if (uid === null) {
                userFilter = " AND user_id IS NULL";
            } else {
                userFilter = " AND user_id = ?";
                queryParams.push(uid);
            }
        }

        // count total items in segment first
        const countRes = await allAsync(
            `select count(*) as c from ${memoriesTable} where segment=?${userFilter}`,
            queryParams,
        ) as { c: number }[];
        const total = countRes[0]?.c || 0;
        if (total === 0) continue;

        const batchSz = Math.max(1, Math.floor(total * env.decayRatio));
        const startIdx = Math.floor(Math.random() * Math.max(1, total - batchSz));

        const rows = (await allAsync(
            `select id, content, generated_summary as summary, salience, decay_lambda as decayLambda, last_seen_at as lastSeenAt, updated_at as updatedAt, primary_sector as primarySector, coactivations, user_id as userId from ${memoriesTable} where segment=?${userFilter} LIMIT ? OFFSET ?`,
            [...queryParams, batchSz, startIdx],
        )) as DecayingMemory[];

        const batch = rows;
        const salUpdates: Array<{ id: string; salience: number; lastSeenAt: number; updatedAt: number }> = [];

        for (const m of batch) {
            const tier = pickTier(m, now);
            tierCounts[tier]++;

            const lam =
                tier === "hot"
                    ? cfg.lambdaHot
                    : tier === "warm"
                        ? cfg.lambdaWarm
                        : cfg.lambdaCold;

            const last = m.lastSeenAt || m.updatedAt || now;
            const dt = Math.max(0, (now - last) / cfg.timeUnitMs);
            const act = Math.max(0, m.coactivations || 0);
            const sal = clampF(
                (m.salience || 0.5) * (1 + Math.log1p(act)),
                0,
                1,
            );
            const f = Math.exp(-lam * (dt / (sal + 0.1)));

            const newSal = clampF(sal * f, 0, 1);
            let structuralChange = false;

            if (f < 0.7) {
                const sector = m.primarySector || "semantic";
                const m_uid = normalizeUserId(m.userId);
                let vecRow = await vectorStore.getVector(
                    m.id,
                    sector,
                    m_uid,
                );
                let isCold = false;

                if (!vecRow) {
                    vecRow = await vectorStore.getVector(
                        m.id,
                        sector + "_cold",
                        m_uid,
                    );
                    isCold = true;
                }

                const enc = getEncryption();
                const decryptedContent = await enc.decrypt(
                    m.content || "",
                );

                if (vecRow && vecRow.vector) {
                    const vec =
                        typeof vecRow.vector === "string"
                            ? JSON.parse(vecRow.vector)
                            : vecRow.vector;
                    const beforeLen = Array.isArray(vec)
                        ? vec.length
                        : 0;

                    if (beforeLen > 0) {
                        const newVec = compressVector(
                            vec,
                            f,
                            cfg.minVecDim,
                            cfg.maxVecDim,
                        );
                        const newSummary = compressSummary(
                            m.summary || decryptedContent,
                            f,
                            cfg.summaryLayers,
                        );

                        if (newVec.length < beforeLen) {
                            const targetSector = sector + "_cold";
                            await vectorStore.storeVector(
                                m.id,
                                targetSector,
                                newVec,
                                newVec.length,
                                m_uid,
                            );
                            if (!isCold) {
                                await vectorStore.deleteVector(
                                    m.id,
                                    sector,
                                    m_uid,
                                );
                            }
                            totComp++;
                            structuralChange = true;
                        }

                        if (newSummary !== (m.summary || "")) {
                            await q.updSummary.run(
                                m.id,
                                newSummary,
                                m_uid,
                            );
                            structuralChange = true;
                        }
                    }
                }

                if (f < Math.max(0.3, cfg.coldThreshold)) {
                    const fp = fingerprintMem(m, decryptedContent);
                    const targetSector = sector + "_cold";
                    await vectorStore.storeVector(
                        m.id,
                        targetSector,
                        fp.vector,
                        fp.vector.length,
                        m_uid,
                    );
                    await vectorStore.deleteVector(m.id, sector, m_uid);
                    await q.updSummary.run(m.id, fp.summary, m_uid);
                    totFp++;
                    structuralChange = true;
                }
            }

            const salChanged = Math.abs(newSal - (m.salience || 0)) > 0.001;
            if (salChanged || structuralChange) {
                salUpdates.push({
                    id: m.id,
                    salience: newSal,
                    lastSeenAt: m.lastSeenAt || now,
                    updatedAt: now,
                });
                totChg++;
            }
            totProc++;
            await tick();
        }

        if (salUpdates.length > 0) {
            await q.updSaliences.run(salUpdates, uid);
        }


        if (seg !== segments[segments.length - 1]) {
            await sleep(env.decaySleepMs);
        }
    }

    const duration = performance.now() - t0;
    if (env.verbose)
        logger.info(
            `[DECAY] ${totChg}/${totProc} | tiers: hot=${tierCounts.hot} warm=${tierCounts.warm} cold=${tierCounts.cold} | compressed=${totComp} fingerprinted=${totFp} | ${duration.toFixed(1)}ms`,
        );
    return { decayed: totChg, processed: totProc };
};

// --- Reinforcement ---

export const onQueryHit = async (
    memId: string,
    sector: string,
    userId?: string | null,
    reembed?: (text: string) => Promise<number[]>,
) => {
    const uid = normalizeUserId(userId);
    if (!cfg.regenerationEnabled && !cfg.reinforceOnQuery) return;

    const m = await q.getMem.get(memId, uid);
    if (!m) return;

    let updated = false;

    if (cfg.regenerationEnabled && reembed) {
        let vecRow = await vectorStore.getVector(memId, sector, uid);
        if (!vecRow)
            vecRow = await vectorStore.getVector(memId, sector + "_cold", uid);

        if (vecRow && vecRow.vector) {
            const vec =
                typeof vecRow.vector === "string"
                    ? JSON.parse(vecRow.vector)
                    : vecRow.vector;
            if (Array.isArray(vec) && vec.length <= 64) {
                try {
                    const enc = getEncryption();
                    const decryptedContent = await enc.decrypt(m.content || "");
                    const newVec = await reembed(decryptedContent);
                    await vectorStore.storeVector(
                        memId,
                        sector,
                        newVec,
                        newVec.length,
                        uid,
                    );
                    await vectorStore.deleteVector(
                        memId,
                        sector + "_cold",
                        uid,
                    );
                    updated = true;
                } catch (e) {
                    logger.debug(`[DECAY] Re-embed failed for ${memId}:`, {
                        error: e,
                    });
                }
            }
        }
    }

    if (cfg.reinforceOnQuery) {
        const newSal = clampF((m.salience || 0.5) + 0.1, 0, 1);
        await q.updSeen.run(memId, Date.now(), newSal, Date.now(), uid);
        updated = true;
    }

    if (updated && env.verbose) {
        logger.info(`[DECAY] regenerated/reinforced memory ${memId}`);
    }
};
