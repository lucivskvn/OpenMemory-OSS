/**
 * @file Hierarchical Storage Graph (HSG) Implementation.
 * Core cognitive logic for OpenMemory, including classifying, decaying, and retrieving memories.
 */
import { env } from "../core/cfg";
import { q, transaction, vectorStore } from "../core/db";
import { eventBus, EVENTS } from "../core/events";
import { sectorConfigs } from "../core/hsg_config";
import { registerInterval, unregisterInterval } from "../core/scheduler";
import { getEncryption } from "../core/security";
import {
    EmbeddingResult,
    HsgQueryResult,
    MemoryRow,
    MultiVecFusionWeights,
    SectorClassification,
} from "../core/types";
import {
    calculateCrossSectorResonance,
    calculateDualPhaseDecayMemoryRetention,
    calculateSpreadingActivationEnergy,
    calculateRecencyScore,
    performSpreadingActivationRetrieval,
    sigmoid
} from "../ops/dynamics";
import { normalizeUserId } from "../utils";
import { SimpleCache } from "../utils/cache";
import { logger } from "../utils/logger";
import { canonicalTokenSet } from "../utils/text";
import { applyDecay, incQ, onQueryHit } from "./decay";
import {
    cosineSimilarity,
    embedMultiSector,
    embedQueryForAllSectors,
} from "./embed";

const sectors = Object.keys(sectorConfigs);

const hybridParams = {
    alphaReinforce: 0.1,
    beta: 2.0,
    epsilon: 1e-6,
    tau: 0.5,
    tauHours: env.graphTemporalWindow / 3600000, // convert back if needed, but lets use it directly
    eta: 0.2,
};

const reinforcement = {
    maxWaypointWeight: 1.0,
    waypointBoost: 0.1,
};

const scoringWeights = {
    similarity: env.scoringSimilarity || 0.5,
    overlap: env.scoringOverlap || 0.2,
    waypoint: env.scoringWaypoint || 0.15,
    recency: env.scoringRecency || 0.1,
    tagMatch: env.scoringTagMatch || 0.05,
};

async function computeTagMatchScore(
    mem: MemoryRow,
    queryTokens: Set<string>,
): Promise<number> {
    if (!mem || !mem.tags) return 0;
    try {
        let tags: string[] = [];
        if (typeof mem.tags === "string") {
            try {
                tags = JSON.parse(mem.tags);
            } catch {
                tags = [];
            }
        } else if (Array.isArray(mem.tags)) {
            tags = mem.tags;
        }
        if (!tags || !Array.isArray(tags)) return 0;

        let matches = 0;
        for (const tag of tags) {
            const tagLower = String(tag).toLowerCase();
            if (queryTokens.has(tagLower)) {
                matches += 2;
            } else {
                for (const token of queryTokens) {
                    if (tagLower.includes(token) || token.includes(tagLower)) {
                        matches += 1;
                    }
                }
            }
        }
        return Math.min(1.0, matches / Math.max(1, tags.length * 2));
    } catch (err) {
        logger.debug(`[HSG] Tag match calculation failed for ${mem.id}:`, {
            error: err,
        });
        return 0;
    }
}

export function classifyContent(
    content: string,
    metadata?: Record<string, unknown>,
): SectorClassification {
    if (
        metadata &&
        typeof metadata.sector === "string" &&
        sectors.includes(metadata.sector)
    ) {
        return { primary: metadata.sector, additional: [], confidence: 1.0 };
    }
    const scores: Record<string, number> = {};
    for (const [sector, config] of Object.entries(sectorConfigs)) {
        let score = 0;
        for (const pattern of config.patterns) {
            const matches = content.match(pattern);
            if (matches) score += matches.length * config.weight;
        }
        scores[sector] = score;
    }
    const sortedScores = Object.entries(scores).sort(([, a], [, b]) => b - a);
    const primary = sortedScores[0][0];
    const primaryScore = sortedScores[0][1];
    const threshold = Math.max(1, primaryScore * 0.3);
    const additional = sortedScores
        .slice(1)
        .filter(([, score]) => score > 0 && score >= threshold)
        .map(([sector]) => sector);
    const confidence =
        primaryScore > 0
            ? Math.min(
                1.0,
                primaryScore /
                (primaryScore + (sortedScores[1]?.[1] || 0) + 1),
            )
            : 0.2;
    return {
        primary: primaryScore > 0 ? primary : "semantic",
        additional,
        confidence,
    };
}


export function calcDecay(
    sec: string,
    initSal: number,
    daysSince: number,
): number {
    return calculateDualPhaseDecayMemoryRetention(initSal, daysSince, sectorConfigs[sec]?.decayLambda || 0.05);
}

export function boostedSim(s: number): number {
    return 1 - Math.exp(-hybridParams.tau * s);
}

export function computeSimhash(text: string): string {
    const tokens = (text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
    if (tokens.length === 0) return new Array(64).fill("0").join("");

    const hashes = tokens.map((t) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < t.length; i++) {
            h ^= t.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    });
    const v = new Array(64).fill(0);
    for (const h of hashes) {
        for (let i = 0; i < 64; i++) {
            if ((h >> (i % 32)) & 1) v[i] += 1;
            else v[i] -= 1;
        }
    }
    let sh = "";
    for (let i = 0; i < 64; i++) sh += v[i] > 0 ? "1" : "0";
    return sh;
}

export function extractEssence(raw: string, maxLen: number): string {
    if (raw.length <= maxLen) return raw;
    const sents = raw
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);
    if (sents.length === 0) return raw.slice(0, maxLen);
    const scoreSent = (s: string, idx: number): number => {
        let sc = 0;
        if (idx === 0) sc += 10;
        if (idx === 1) sc += 5;
        if (/^#+\s/.test(s) || /^[A-Z][A-Z\s]+:/.test(s)) sc += 8;
        if (/^[A-Z][a-z]+:/i.test(s)) sc += 6;
        if (/\d{4}-\d{2}-\d{2}/.test(s)) sc += 7;
        if (
            /\b(bought|visited|went|learned|discovered|found|saw|met)\b/i.test(
                s,
            )
        )
            sc += 4;
        if (s.length < 80) sc += 2;
        return sc;
    };
    const scored = sents.map((s, idx) => ({
        text: s,
        score: scoreSent(s, idx),
        idx,
    }));
    scored.sort((a, b) => b.score - a.score);
    const selected: typeof scored = [];
    let currentLen = 0;
    for (const item of scored) {
        if (currentLen + item.text.length + 2 <= maxLen) {
            selected.push(item);
            currentLen += item.text.length + 2;
        }
    }
    selected.sort((a, b) => a.idx - b.idx);
    return selected.map((s) => s.text).join(" ");
}

export function computeTokenOverlap(
    qToks: Set<string>,
    memToks: Set<string>,
): number {
    if (qToks.size === 0) return 0;
    let ov = 0;
    for (const t of qToks) if (memToks.has(t)) ov++;
    return ov / qToks.size;
}

export function computeHybridScore(
    sim: number,
    tokOv: number,
    wpWt: number,
    recSc: number,
    keywordScore: number = 0,
    tagMatch: number = 0,
): number {
    const sP = boostedSim(sim);
    const raw =
        scoringWeights.similarity * sP +
        scoringWeights.overlap * tokOv +
        scoringWeights.waypoint * wpWt +
        scoringWeights.recency * recSc +
        scoringWeights.tagMatch * tagMatch +
        keywordScore;
    return sigmoid(raw);
}

export async function createCrossSectorWaypoints(
    primId: string,
    _primSec: string,
    addSecs: string[],
    userId?: string | null,
): Promise<void> {
    const now = Date.now(),
        wt = 0.5;
    const uid = userId === undefined ? undefined : normalizeUserId(userId);
    for (const sec of addSecs) {
        await q.insWaypoint.run(primId, `${primId}:${sec}`, uid, wt, now, now);
        await q.insWaypoint.run(`${primId}:${sec}`, primId, uid, wt, now, now);
    }
}

export function calcMeanVec(
    embRes: EmbeddingResult[],
    _secs: string[],
): number[] {
    const dim = embRes[0].vector.length;
    const wsum = new Array(dim).fill(0);
    const secScores = embRes.map((r) => ({
        vector: r.vector,
        confidence: sectorConfigs[r.sector]?.weight || 1.0,
    }));
    const beta = hybridParams.beta;
    const expSum = secScores.reduce(
        (sum, s) => sum + Math.exp(beta * s.confidence),
        0,
    );
    for (const result of embRes) {
        const smWt =
            Math.exp(beta * (sectorConfigs[result.sector]?.weight || 1.0)) /
            expSum;
        for (let i = 0; i < dim; i++) wsum[i] += result.vector[i] * smWt;
    }
    const norm =
        Math.sqrt(wsum.reduce((sum, v) => sum + v * v, 0)) +
        hybridParams.epsilon;
    return wsum.map((v) => v / norm);
}

export async function spreadingActivation(
    initRes: string[],
    maxExp = 50,
    userId?: string | null,
): Promise<Array<{ id: string; weight: number; path: string[] }>> {
    const activationMap = await performSpreadingActivationRetrieval(
        initRes,
        Math.min(maxExp, 3), // Iterations, not maxExp. Default to low hop count.
        userId ?? undefined,
    );

    const results: Array<{ id: string; weight: number; path: string[] }> = [];
    for (const [id, energy] of activationMap) {
        if (energy < 0.1) continue;
        results.push({
            id,
            weight: energy,
            path: [id], // Simple energy-based model doesn't keep full paths by default for performance
        });
    }

    return results.sort((a, b) => b.weight - a.weight);
}

export async function reinforceWaypoints(
    travPath: string[],
    userId?: string | null,
): Promise<void> {
    const now = Date.now();
    const uid = userId === undefined ? undefined : normalizeUserId(userId);
    for (let i = 0; i < travPath.length - 1; i++) {
        const wp = await q.getWaypoint.get(travPath[i], travPath[i + 1], uid);
        if (wp)
            await q.updWaypoint.run(
                travPath[i],
                Math.min(
                    reinforcement.maxWaypointWeight,
                    wp.weight + reinforcement.waypointBoost,
                ),
                now,
                travPath[i + 1],
                uid,
            );
    }
}

// Imports moved to top

export async function calcMultiVecFusionScore(
    mid: string,
    qe: Record<string, number[]>,
    w: MultiVecFusionWeights,
    userId?: string | null,
): Promise<number> {
    const uid = userId === undefined ? undefined : normalizeUserId(userId);
    const vecs = await vectorStore.getVectorsById(mid, uid);
    let sum = 0,
        tot = 0;
    const wm: Record<string, number> = {
        semantic: w.semanticDimensionWeight,
        emotional: w.emotionalDimensionWeight,
        procedural: w.proceduralDimensionWeight,
        episodic: w.temporalDimensionWeight,
        reflective: w.reflectiveDimensionWeight,
    };
    for (const v of vecs) {
        if (!qe[v.sector]) continue;
        const sim = cosineSimilarity(qe[v.sector], v.vector);
        const wgt = wm[v.sector] || 0.5;
        sum += sim * wgt;
        tot += wgt;
    }
    return tot > 0 ? sum / tot : 0;
}

const cache = new SimpleCache<string, { r: HsgQueryResult[]; t: number }>({
    maxSize: 500,
});
const coactBuf: Array<[string | undefined, string, string]> = [];
let hsgIntervalId: string | null = null;

export const startHsgMaintenance = () => {
    if (hsgIntervalId) return;
    hsgIntervalId = registerInterval(
        "hsg",
        async () => {
            if (!coactBuf.length) return;
            const pairs = coactBuf.splice(0, 50);
            const now = Date.now(),
                tauMs = env.graphTemporalWindow; // use directly from env
            for (const [uid, a, b] of pairs) {
                try {
                    const [memA, memB] = await Promise.all([
                        q.getMem.get(a, uid),
                        q.getMem.get(b, uid),
                    ]);
                    if (!memA || !memB || memA.userId !== memB.userId) continue;
                    const tempFact = Math.exp(
                        -Math.abs(
                            (memA.lastSeenAt || 0) - (memB.lastSeenAt || 0),
                        ) / tauMs,
                    );
                    const wp = await q.getWaypoint.get(
                        a,
                        b,
                        memA.userId ?? undefined,
                    );
                    const newWt = Math.min(
                        1,
                        (wp?.weight || 0) +
                        hybridParams.eta *
                        (1 - (wp?.weight || 0)) *
                        tempFact,
                    );
                    await q.insWaypoint.run(
                        a,
                        b,
                        memA.userId ?? null,
                        newWt,
                        wp?.createdAt || now,
                        now,
                    );
                } catch (e) {
                    logger.warn("[HSG] Coactivation update failed:", {
                        error: e,
                    });
                }
            }
        },
        1000,
    );

};

export const stopHsgMaintenance = () => {
    if (hsgIntervalId) {
        unregisterInterval(hsgIntervalId);
        hsgIntervalId = null;
    }
};

if (typeof process === "undefined" || !env.isTest) startHsgMaintenance();

export async function hsgQuery(
    qt: string,
    k = 10,
    f?: {
        sectors?: string[];
        minSalience?: number;
        userId?: string | null;
        startTime?: number;
        endTime?: number;
        metadata?: Record<string, unknown>;
    },
): Promise<HsgQueryResult[]> {
    incQ();
    try {
        // Stable cache key generation
        const stableFilter = f
            ? Object.keys(f)
                .sort()
                .reduce((obj, key) => {
                    obj[key] = (f as Record<string, unknown>)[key];
                    return obj;
                }, {} as Record<string, unknown>)
            : {};
        const h = `${qt}:${k}:${JSON.stringify(stableFilter)}`;
        const cached = cache.get(h);
        if (cached && Date.now() - cached.t < env.hsgCacheTtlMs) return cached.r;
        const qc = classifyContent(qt),
            qtk = canonicalTokenSet(qt);

        const primarySectors = Array.from(
            new Set([qc.primary, ...qc.additional, ...(f?.sectors || [])]),
        );
        const sr = await embedQueryForAllSectors(qt, primarySectors).catch((e) => {
            logger.warn(`[HSG] Embedding failed for query "${qt}", falling back to keyword search:`, { error: e });
            return null;
        });

        if (!sr) {
            // Fallback to keyword search
            const memories = await q.searchMemsByKeyword.all(qt, k, f?.userId);
            if (memories.length === 0) return [];

            // Process keyword matches into HsgQueryResult format
            const enc = getEncryption();
            const results: HsgQueryResult[] = await Promise.all(memories.map(async (m) => {
                const content = await enc.decrypt(m.content || "");
                let tags = [];
                try { tags = m.tags ? (typeof m.tags === "string" ? JSON.parse(m.tags) : m.tags) : []; } catch { }
                let metadata = {};
                try { metadata = m.metadata ? (typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata) : {}; } catch { }

                return {
                    id: m.id,
                    content: content || "",
                    score: 0.5, // Neutral score for simple fallback matches
                    sectors: [m.primarySector],
                    primarySector: m.primarySector,
                    path: [m.id],
                    salience: m.salience || 0.5,
                    lastSeenAt: m.lastSeenAt || 0,
                    createdAt: m.createdAt || 0,
                    tags,
                    metadata,
                    updatedAt: m.updatedAt || 0,
                    decayLambda: m.decayLambda,
                    version: m.version,
                    segment: m.segment,
                    simhash: m.simhash,
                    generatedSummary: m.generatedSummary,
                } as HsgQueryResult;
            }));
            const final = { r: results, t: Date.now() };
            cache.set(h, final);
            return results;
        }

        const qe: Record<string, number[]> = {};
        for (const r of sr) qe[r.sector] = r.vector;
        const w: MultiVecFusionWeights = {
            semanticDimensionWeight: 1,
            emotionalDimensionWeight: 0.8,
            proceduralDimensionWeight: 0.9,
            temporalDimensionWeight: 1.2,
            reflectiveDimensionWeight: 0.7,
        };
        const results: HsgQueryResult[] = [];
        const seen = new Set<string>();
        const candidates = new Map<string, { vectorScore: number; searchSector: string }>();

        // 1. Gather Candidates (Parallel Search)
        // Limit concurrency to avoid overloading vector store if many sectors
        // 1. Gather Candidates (Parallel Search)
        // Limit concurrency to avoid overloading vector store if many sectors
        const searchPromises = sr.map(async (srItem) => {
            const matches = await vectorStore.searchSimilar(
                srItem.sector,
                srItem.vector,
                k * 2,
                f?.userId,
                f?.metadata ? { metadata: f.metadata } : undefined,
            );
            return { matches, sector: srItem.sector };
        });

        const allMatches = await Promise.all(searchPromises);

        for (const { matches, sector } of allMatches) {
            for (const mat of matches) {
                if (!candidates.has(mat.id)) {
                    candidates.set(mat.id, { vectorScore: mat.score, searchSector: sector });
                } else {
                    const curr = candidates.get(mat.id)!;
                    if (mat.score > curr.vectorScore) {
                        candidates.set(mat.id, { vectorScore: mat.score, searchSector: sector });
                    }
                }
            }
        }

        const candidateIds = Array.from(candidates.keys());
        if (candidateIds.length === 0) return [];

        // 2. Batch Fetch Memories and Vectors
        const [memories, allVectors] = await Promise.all([
            q.getMems.all(candidateIds, f?.userId),
            vectorStore.getVectorsByIds(candidateIds, f?.userId),
        ]);

        // Index vectors by Memory ID
        const vectorsMap = new Map<string, Array<{ sector: string; vector: number[] }>>();
        for (const v of allVectors) {
            if (!vectorsMap.has(v.id)) vectorsMap.set(v.id, []);
            vectorsMap.get(v.id)!.push(v);
        }

        const enc = getEncryption();

        // 3. Process Candidates in Memory
        await Promise.all(memories.map(async (m) => {
            const cand = candidates.get(m.id);
            if (!cand) return;

            // Filters
            if (f?.startTime && (m.createdAt || 0) < f.startTime) return;
            if (f?.endTime && (m.createdAt || 0) > f.endTime) return;
            if (f?.minSalience) {
                const age = (Date.now() - (m.lastSeenAt || 0)) / 86400000;
                const sal = calcDecay(m.primarySector, m.salience || 0.5, age);
                if (sal < f.minSalience) return;
            }

            const decryptedContent = await enc.decrypt(m.content || "");
            if (!decryptedContent && m.content) {
                logger.warn(`[HSG] Decryption produced empty content for memory ${m.id}`);
                return;
            }

            // Calculate Fusion Score (In-Memory)
            const mVecs = vectorsMap.get(m.id) || [];
            let sum = 0, tot = 0;
            const wm: Record<string, number> = {
                semantic: w.semanticDimensionWeight,
                emotional: w.emotionalDimensionWeight,
                procedural: w.proceduralDimensionWeight,
                episodic: w.temporalDimensionWeight,
                reflective: w.reflectiveDimensionWeight,
            };

            for (const v of mVecs) {
                if (!qe[v.sector]) continue;
                const sim = cosineSimilarity(qe[v.sector], v.vector);
                const wgt = wm[v.sector] || 0.5;
                sum += sim * wgt;
                tot += wgt;
            }
            const mvf = tot > 0 ? sum / tot : 0;

            const resonance = await calculateCrossSectorResonance(
                m.primarySector,
                f?.sectors?.[0] || "semantic",
                mvf,
            );

            const age = (Date.now() - (m.lastSeenAt || 0)) / 86400000;
            const sal = calcDecay(m.primarySector, m.salience || 0.5, age);

            const tokOv = computeTokenOverlap(
                qtk,
                canonicalTokenSet(decryptedContent || ""),
            );
            const recSc = calculateRecencyScore(m.lastSeenAt || 0, hybridParams.tau);
            const hs = computeHybridScore(
                cand.vectorScore,
                tokOv,
                0, // No waypoints in search result path context currently
                recSc,
                0,
                await computeTagMatchScore(m, qtk),
            );

            let parsedTags = [];
            try { parsedTags = m.tags ? (typeof m.tags === "string" ? JSON.parse(m.tags) : m.tags) : []; } catch { }
            let parsedMeta = {};
            try { parsedMeta = m.metadata ? (typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata) : {}; } catch { }

            results.push({
                id: m.id,
                content: decryptedContent || "",
                score: hs * resonance,
                sectors: [m.primarySector],
                primarySector: m.primarySector,
                path: [m.id],
                salience: sal,
                lastSeenAt: m.lastSeenAt || 0,
                createdAt: m.createdAt || 0,
                tags: parsedTags,
                metadata: parsedMeta,
                updatedAt: m.updatedAt || 0,
                decayLambda: m.decayLambda,
                version: m.version,
                segment: m.segment,
                simhash: m.simhash,
                generatedSummary: m.generatedSummary,
            });
        }));

        results.sort((a, b) => b.score - a.score);
        const top = results.slice(0, k);

        // Populate Coactivation Buffer
        if (top.length > 1) {
            for (let i = 0; i < top.length; i++) {
                for (let j = i + 1; j < Math.min(top.length, 5); j++) {
                    if (coactBuf.length < 500) {
                        coactBuf.push([
                            normalizeUserId(f?.userId) ?? undefined,
                            top[i].id,
                            top[j].id,
                        ]);
                    }
                }
            }
        }

        for (const r of top) {
            onQueryHit(r.id, r.primarySector, f?.userId ?? null, async (text) => {
                const { embedForSector } = await import("./embed");
                return embedForSector(text, r.primarySector);
            }).catch(() => { });
        }
        const final = { r: top, t: Date.now() };
        cache.set(h, final);
        return top;
    } catch (e) {
        logger.error("[HSG] Query failed:", { error: e });
        return [];
    }
}

export async function addMemory(
    content: string,
    userId: string | undefined | null,
    metadata?: Record<string, unknown>,
    overrides?: { id?: string; createdAt?: number },
): Promise<{
    id: string;
    primarySector: string;
    sectors: string[];
    chunks: number;
    content: string;
    createdAt: number;
    userId: string | null;
}> {
    let qc = classifyContent(content, metadata);
    const now = overrides?.createdAt || Date.now();

    // Try to upgrade classification using Learned Classifier
    if (
        userId &&
        (!metadata || !metadata.sector) &&
        qc.primary === "semantic"
    ) {
        // Only if default/uncertain
        try {
            const { LearnedClassifier } =
                await import("../core/learned_classifier");
            const model = await LearnedClassifier.load(userId);
            if (model) {
                // We need a vector. Compute semantic vector first.
                const { embedForSector } = await import("./embed");
                const vecRes = await embedForSector(content, "semantic");

                // Predict
                const Pred = LearnedClassifier.predict(vecRes, model);

                // If high confidence, override
                if (Pred.confidence > 0.6) {
                    qc = Pred;
                    logger.debug(
                        `[HSG] Classifier override: ${qc.primary} (conf: ${qc.confidence.toFixed(2)})`,
                    );
                }
            }
        } catch {
            // Ignore classifier errors, fallback to regex
        }
    }

    const primSec = qc.primary;
    const uid = userId === undefined ? undefined : normalizeUserId(userId);

    // Idempotency / Deduplication Check (Only if no ID override)
    if (!overrides?.id) {
        const sh = computeSimhash(content);
        const existing = await q.getMemBySimhash.get(sh, uid);
        if (existing) {
            const enc = getEncryption();
            const existingContent = await enc.decrypt(existing.content);

            // Only treat as duplicate if content actually matches
            if (existingContent === content) {
                logger.debug(`[HSG] Dedup: Memory already exists (${existing.id})`);
                // If content is identical, we can just reinforce it? Or just return it.
                // Returning it ensures idempotency.
                try {
                    JSON.parse(existing.tags || "[]");
                } catch { }
                // Update lastSeenAt to reflect re-occurrence
                await q.updSeen.run(
                    existing.id,
                    now,
                    Math.min(1.0, (existing.salience || 0.5) + 0.1),
                    now,
                    uid,
                );
                return {
                    id: existing.id,
                    primarySector: existing.primarySector,
                    sectors: [existing.primarySector],
                    chunks: 1,
                    content: content,
                    createdAt: existing.createdAt || now,
                    userId: existing.userId,
                };
            } else {
                logger.warn(`[HSG] SimHash collision detected for ${existing.id} (content mismatch). Creating new memory.`);
            }
        }
    }

    const id = overrides?.id || crypto.randomUUID();

    // Multi-sector embedding for broader search coverage
    const addSecs = [primSec, ...qc.additional];

    let embRes: EmbeddingResult[];
    try {
        embRes = await embedMultiSector(
            id,
            content,
            addSecs,
            undefined,
            userId || undefined,
        );
    } catch (e) {
        logger.error(`[HSG] Embedding failed for ${id}:`, { error: e });
        throw e; // Fail early if embeddings fail
    }

    const primRes = embRes.find((r) => r.sector === primSec) || embRes[0];
    const meanVec = primRes.vector;
    const meanVecBuf = Buffer.from(new Float32Array(meanVec).buffer);

    const enc = getEncryption();
    const encryptedContent = await enc.encrypt(content);

    const safeJson = (obj: any) => {
        try {
            return JSON.stringify(obj);
        } catch {
            return "{}";
        }
    };

    // Execute in transaction for atomicity (DB + Vector Store)
    return await transaction.run(async () => {
        // 1. Insert into Main DB
        await q.insMem.run(
            id,
            encryptedContent,
            primSec,
            safeJson(metadata?.tags || []),
            safeJson(metadata || {}),
            uid ?? null,
            0,
            computeSimhash(content),
            now,
            now,
            now,
            typeof metadata?.salience === "number" ? metadata.salience : 0.5,
            typeof metadata?.decayLambda === "number"
                ? metadata.decayLambda
                : sectorConfigs[primSec].decayLambda,
            1,
            meanVec.length,
            meanVecBuf,
            meanVecBuf,
            0,
            null,
        );

        // 2. Insert into Vector Store
        for (const res of embRes) {
            await vectorStore.storeVector(
                id,
                res.sector,
                res.vector,
                res.dim,
                uid,
                metadata,
            );
        }

        // 3. Create Cross-Sector Waypoints
        if (qc.additional.length > 0) {
            await createCrossSectorWaypoints(id, primSec, qc.additional, uid).catch(
                (e) =>
                    logger.warn(
                        `[HSG] Failed to create cross-sector waypoints for ${id}:`,
                        { error: e },
                    ),
            );
        }

        eventBus.emit(EVENTS.MEMORY_ADDED, {
            id,
            primarySector: primSec,
            content,
            userId: userId || undefined,
            createdAt: now,
            sectors: [primSec, ...qc.additional],
        });

        return {
            id,
            primarySector: primSec,
            sectors: [primSec, ...qc.additional],
            chunks: 1,
            content,
            createdAt: now,
            userId: userId || null,
        };
    });
}

export async function addHsgMemory(
    content: string,
    tagsStr?: string | null,
    metadata: Record<string, unknown> = {},
    userId?: string | null,
    overrides?: { id?: string; createdAt?: number },
): Promise<{
    id: string;
    primarySector: string;
    sectors: string[];
    chunks: number;
    content: string;
    createdAt: number;
    userId: string | null;
}> {
    const tags = tagsStr
        ? JSON.parse(tagsStr)
        : (metadata?.tags as string[]) || [];
    return await addMemory(content, userId, { ...metadata, tags }, overrides);
}

export async function addMemories(
    items: Array<{ content: string; metadata?: Record<string, unknown> }>,
    userId: string | undefined | null,
): Promise<Array<{ id: string; primarySector: string }>> {
    const now = Date.now();
    const enc = getEncryption();
    const uid = normalizeUserId(userId);

    // 1. Prepare items (Classification, Simhash, Encryption)
    const processedItems = await Promise.all(
        items.map(async (item) => {
            const id = crypto.randomUUID();
            const qc = classifyContent(item.content, item.metadata);
            const sh = computeSimhash(item.content);
            const encryptedContent = await enc.encrypt(item.content);
            return {
                id,
                content: item.content,
                encryptedContent,
                metadata: item.metadata || {},
                primarySector: qc.primary,
                additionalSectors: qc.additional,
                simhash: sh,
                createdAt: now,
            };
        }),
    );

    // 2. Parallel Embedding with Chunking (OOM Protection)
    const embeddingResults: Array<{
        id: string;
        embRes: EmbeddingResult[];
        meanVec: number[];
        meanDim: number;
    }> = [];

    const EMBED_CHUNK_SIZE = 20; // Process 20 items at a time to avoid OOM
    for (let i = 0; i < processedItems.length; i += EMBED_CHUNK_SIZE) {
        const chunk = processedItems.slice(i, i + EMBED_CHUNK_SIZE);
        const chunkResults = await Promise.all(
            chunk.map(async (item) => {
                const addSecs = [item.primarySector, ...item.additionalSectors];
                const embRes = await embedMultiSector(
                    item.id,
                    item.content,
                    addSecs,
                    undefined,
                    userId || undefined,
                );
                const primRes =
                    embRes.find((r) => r.sector === item.primarySector) ||
                    embRes[0];
                return {
                    id: item.id,
                    embRes,
                    meanVec: primRes.vector,
                    meanDim: primRes.dim,
                };
            }),
        );
        embeddingResults.push(...chunkResults);
    }

    // 3. Batch Main DB Insert
    const dbItems = processedItems.map((item, i) => {
        const emb = embeddingResults[i];
        const meanVecBuf = Buffer.from(new Float32Array(emb.meanVec).buffer);
        return {
            id: item.id,
            content: item.encryptedContent,
            primarySector: item.primarySector,
            tags: JSON.stringify(item.metadata.tags || []),
            metadata: JSON.stringify(item.metadata),
            userId: uid ?? null,
            segment: 0,
            simhash: item.simhash,
            createdAt: item.createdAt,
            updatedAt: item.createdAt,
            lastSeenAt: item.createdAt,
            salience: 0.5,
            decayLambda: sectorConfigs[item.primarySector].decayLambda,
            version: 1,
            meanDim: emb.meanDim,
            meanVec: meanVecBuf,
            compressedVec: meanVecBuf,
            feedbackScore: 0,
            generatedSummary: null,
        };
    });

    const result = await transaction.run(async () => {
        try {
            await q.insMems.run(dbItems);
        } catch (e) {
            logger.error(`[HSG] Batch DB insertion failed:`, { error: e });
            throw e;
        }

        // 4. Batch Vector Store Insert
        const vectorItems: Array<{
            id: string;
            sector: string;
            vector: number[];
            dim: number;
        }> = [];
        for (const emb of embeddingResults) {
            for (const res of emb.embRes) {
                vectorItems.push({
                    id: emb.id,
                    sector: res.sector,
                    vector: res.vector,
                    dim: res.dim,
                });
            }
        }

        try {
            await vectorStore.storeVectors(vectorItems, userId);
        } catch (e) {
            logger.error(`[HSG] Batch vector storage failed for user ${userId}:`, { error: e });
            throw e; // Rollback DB
        }

        return processedItems.map((p) => ({
            id: p.id,
            primarySector: p.primarySector,
        }));
    });

    return result;
}

export async function addHsgMemories(
    items: Array<{ content: string; metadata?: Record<string, unknown> }>,
    userId?: string | null,
): Promise<Array<{ id: string; primarySector: string }>> {
    return await addMemories(items, userId);
}

export const runDecayProcess = applyDecay;

export async function reinforceMemory(
    id: string,
    boost = 0.1,
    userId?: string | null,
) {
    const m = await q.getMem.get(id, userId);
    if (!m) throw new Error("Memory not found");
    const newSal = Math.min(1.0, (m.salience || 0.5) + boost);
    await q.updSeen.run(
        id,
        m.lastSeenAt || Date.now(),
        newSal,
        Date.now(),
        userId,
    );
}

export async function updateMemory(
    id: string,
    content?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    userId?: string | null,
) {
    const m = await q.getMem.get(id, userId);
    if (!m) throw new Error("Memory not found");

    const newContent = content ?? m.content;
    const newTags = tags ? JSON.stringify(tags) : m.tags;
    const newMeta = metadata ? JSON.stringify(metadata) : m.metadata;

    let finalContent = m.content;
    let embRes: EmbeddingResult[] | null = null;
    let meanVecBuf: Buffer | null = null;
    let dim: number = 0;

    if (content !== undefined) {
        // 1. Prepare Data & Embeddings (No Side Effects)
        const qc = classifyContent(newContent, metadata);
        const addSecs = [qc.primary, ...qc.additional];
        embRes = await embedMultiSector(
            id,
            newContent,
            addSecs,
            undefined,
            userId || undefined,
        );
        const primRes =
            embRes.find((r) => r.sector === qc.primary) || embRes[0];
        const meanVec = primRes.vector;
        meanVecBuf = Buffer.from(new Float32Array(meanVec).buffer);
        dim = meanVec.length;

        finalContent = await getEncryption().encrypt(newContent);
    }

    // 3. Database & Vector Updates (Transactional)
    try {
        await transaction.run(async () => {
            // Update Vectors only if re-embedded
            if (embRes) {
                await vectorStore.deleteVectors([id], userId || null);
                for (const res of embRes) {
                    await vectorStore.storeVector(
                        id,
                        res.sector,
                        res.vector,
                        res.dim,
                        userId || undefined,
                    );
                }
            }

            // Update Metadata / Mean Vector
            if (meanVecBuf && dim > 0) {
                await q.updMeanVec.run(id, dim, meanVecBuf, userId || null);
            }
            await q.updMem.run(
                finalContent,
                m.primarySector,
                newTags || "",
                newMeta || "",
                Date.now(),
                id,
                userId,
            );
        });
    } catch (e) {
        logger.error(`[HSG] Update failed for memory ${id}:`, { error: e });
        throw e;
    }

    return { id, ok: true };
}

export async function pruneWeakWaypoints(
    threshold = 0.1,
    userId?: string | null,
) {
    await q.pruneWaypoints.run(threshold, userId);
}
