/**
 * @file Hierarchical Storage Graph (HSG) Implementation.
 * Core cognitive logic for OpenMemory, including classifying, decaying, and retrieving memories.
 * 
 * @audited 2026-01-19
 */
import { env } from "../core/cfg";
import { q, transaction, vectorStore } from "../core/db";
import { eventBus, EVENTS } from "../core/events";
import { hybridParams, sectorConfigs } from "../core/hsg_config";
import { registerInterval, unregisterInterval } from "../core/scheduler";
import { Security } from "../core/security";
import { LearnedClassifier } from "../core/learned_classifier";
import {
    EmbeddingResult,
    HsgQueryResult,
    MemoryItem,
    MemoryRow,
    MultiVecFusionWeights,
    SectorClassification,
    Waypoint,
} from "../core/types";
import {
    calculateCrossSectorResonance,
    calculateDualPhaseDecayMemoryRetention,
    calculateRecencyScore
} from "../ops/dynamics";
import { normalizeUserId, parseJSON } from "../utils";
import { SimpleCache } from "../utils/cache";
import { logger } from "../utils/logger";
import { canonicalTokenSet, computeSimhash, extractEssence } from "../utils/text";
export { computeSimhash, extractEssence };
import { applyDecay, incQ, decQ, onQueryHit } from "./consolidation";

import {
    aggregateVectors,
    cosineSimilarity,
    vectorToUint8Array
} from "../utils/vectors";
import { Embedder } from "./embed";
import {
    calcMeanVec,
    classifyContent,
    computeHybridScore,
    computeTagMatchScore,
    computeTokenOverlap,
    getSectorWeights,
} from "./utils";

const COACTIVATION_FLUSH_INTERVAL = 60000; // 1 minute
let lastFlushTime = Date.now();

// generateSimhash replaced by computeSimhash from utils/text.ts

const sectors = Object.keys(sectorConfigs);

const reinforcement = {
    maxWaypointWeight: 1.0,
    waypointBoost: 0.1,
};

// Safe decay lambda calculation
function calculateDecayLambda(content: string, sectors: string[]): number {
    const baseDecay = env.decayLambda || 0.001;
    // Validate sector decay logic or usage of config
    let lambda = baseDecay;
    for (const sector of sectors) {
        if (sectorConfigs[sector]?.decayLambda) {
            lambda = Math.min(lambda, sectorConfigs[sector].decayLambda);
        }
    }

    if (isNaN(lambda) || lambda < 0) {
        logger.warn('[HSG] Invalid decay lambda calculated, using default', { lambda });
        return baseDecay;
    }

    return lambda;
}

export function calcDecay(
    sec: string,
    initSal: number,
    daysSince: number,
    manualLambda?: number,
): number {
    // Force usage of safe lambda, with optional override
    const lambda = (typeof manualLambda === 'number' && manualLambda > 0) ? manualLambda : calculateDecayLambda("", [sec]);
    return calculateDualPhaseDecayMemoryRetention(initSal, daysSince, lambda);
}

// computeSimhash moved to utils/text.ts
export function boostedSim(s: number): number {
    // Cap result
    return Math.min(1.0, 1 - Math.exp(-hybridParams.tau * s));
}
// extractEssence moved to utils/text.ts

// Fix 1: Wrap createCrossSectorWaypoints in transaction
export async function createCrossSectorWaypoints(
    primId: string,
    _primSec: string,
    addSecs: string[],
    userId?: string | null,
): Promise<void> {
    const uid = normalizeUserId(userId) ?? null;
    if (addSecs.length === 0) return;
    const now = Date.now(),
        wt = 0.5;

    await q.transaction.run(async () => {
        for (const sec of addSecs) {
            await q.insWaypoint.run(primId, `${primId}:${sec}`, uid, wt, now, now);
            await q.insWaypoint.run(`${primId}:${sec}`, primId, uid, wt, now, now);
        }
    });
}



export async function spreadingActivation(
    seedIds: string | string[],
    maxExp = 50,
    userId?: string | null,
): Promise<Array<{ id: string; weight: number; path: string[] }>> {
    const uid = normalizeUserId(userId) ?? null;
    const seeds = Array.isArray(seedIds) ? seedIds : [seedIds];
    const activated = new Map<string, { weight: number; path: string[] }>();
    const queue: Array<{ id: string; level: number; weight: number; path: string[] }> = [];

    // Initialize with provided seeds
    for (const id of seeds) {
        queue.push({ id, level: 0, weight: 1.0, path: [id] });
    }

    let iterations = 0;
    while (queue.length > 0 && iterations < maxExp) {
        const item = queue.shift();
        if (!item) break;
        const { id, level, weight, path } = item;
        iterations++;

        const existing = activated.get(id);
        if (existing && existing.weight >= weight) continue;
        activated.set(id, { weight, path });

        if (level >= 3 || weight < 0.1) continue;

        const waypoints = await q.getWaypointsBySrc.all(id, uid) as Waypoint[];

        for (const wp of waypoints) {
            if (path.includes(wp.dstId)) continue;

            const newWeight = weight * wp.weight * 0.8;
            if (newWeight >= 0.1) {
                queue.push({
                    id: wp.dstId,
                    level: level + 1,
                    weight: newWeight,
                    path: [...path, wp.dstId],
                });
            }
        }
    }

    return Array.from(activated.entries()).map(([id, val]) => ({
        id,
        weight: val.weight,
        path: val.path,
    })).sort((a, b) => b.weight - a.weight);
}

const MAX_WAYPOINT_WEIGHT = 1.0;

export async function reinforceWaypoints(
    travPath: string[],
    userId?: string | null,
): Promise<void> {
    const uid = normalizeUserId(userId) ?? null;
    if (travPath.length < 2) return;
    const now = Date.now();
    const updates: Array<{ srcId: string; dstId: string; userId: string | null; weight: number; createdAt: number; updatedAt: number }> = [];

    // Ticket #2 logic: reinforce existing, check overflow
    // To batch this correctly, we might need to know the edges.
    // Assumes travPath is a sequence.

    await q.transaction.run(async () => {
        for (let i = 0; i < travPath.length - 1; i++) {
            // Use locking to prevent lost updates
            const wp = await q.getWaypoint.get(travPath[i], travPath[i + 1], uid, true);
            if (wp) {
                // Multiplicative update per ticket
                const newWeight = Math.min(
                    wp.weight * (1 + env.reinfWaypointBoost),
                    MAX_WAYPOINT_WEIGHT
                );

                updates.push({
                    srcId: travPath[i],
                    dstId: travPath[i + 1],
                    userId: uid ?? null,
                    weight: newWeight,
                    createdAt: wp.createdAt,
                    updatedAt: now,
                });
            }
        }
        if (updates.length > 0) {
            await q.insWaypoints.run(updates);
        }
    });
}

export async function calcMultiVecFusionScore(
    mid: string,
    qe: Record<string, number[]>,
    w: MultiVecFusionWeights,
    userId?: string | null,
): Promise<number> {
    const uid = normalizeUserId(userId) ?? null;
    const vecs = await vectorStore.getVectorsById(mid, uid);
    if (vecs.length === 0) return 0;
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

async function processCoactivations(pairs: Array<[string | undefined, string, string]>) {
    if (pairs.length === 0) return;
    const now = Date.now();
    const tauMs = 3600 * 1000 * 24;

    await q.transaction.run(async () => {
        const allIds = Array.from(new Set(pairs.flatMap(([_, a, b]) => [a, b])));
        const mems = await q.getMems.all(allIds);
        const memMap = new Map<string, MemoryRow>(mems.map((m: MemoryRow) => [m.id, m]));

        // Batch fetch all waypoints for these pairs with LOCK
        const chunkSize = 50;
        for (let i = 0; i < pairs.length; i += chunkSize) {
            const chunk = pairs.slice(i, i + chunkSize);
            const wpPairs = chunk.map((p) => ({ src: p[1], dst: p[2] }));
            const wpMap = (await q.getWaypointsForPairs.all(
                wpPairs,
                chunk[0]?.[0],
                true // Lock rows
            )) as Map<string, Waypoint>;

            const updates: Array<{
                srcId: string;
                dstId: string;
                userId: string | null;
                weight: number;
                createdAt: number;
                updatedAt: number;
            }> = [];

            for (const [uid, a, b] of chunk) {
                try {
                    const memA = memMap.get(a);
                    const memB = memMap.get(b);
                    if (!memA || !memB || memA.userId !== memB.userId) continue;
                    if (uid && memA.userId !== uid) continue;

                    const tempFact = Math.exp(
                        -Math.abs(
                            (memA.lastSeenAt || 0) - (memB.lastSeenAt || 0),
                        ) / tauMs,
                    );
                    const wp = wpMap.get(`${a}:${b}`);
                    const newWt = Math.min(
                        1,
                        (wp?.weight || 0) +
                        hybridParams.eta *
                        (1 - (wp?.weight || 0)) *
                        tempFact,
                    );

                    updates.push({
                        srcId: a,
                        dstId: b,
                        userId: memA.userId ?? null,
                        weight: newWt,
                        createdAt: wp?.createdAt || now,
                        updatedAt: now,
                    });
                } catch (e: unknown) {
                    logger.warn("[HSG] Coactivation calc failed during flush:", { error: e });
                }
            }

            if (updates.length > 0) {
                await q.insWaypoints.run(updates).catch((e: unknown) => {
                    logger.error("[HSG] Failed to persist flush updates:", { error: e });
                });
            }
        }
    });
}

export const startHsgMaintenance = () => {
    if (hsgIntervalId) return;
    hsgIntervalId = registerInterval(
        "hsg",
        async () => {
            // Optimization: Check length first to avoid busy loop work
            if (coactBuf.length === 0) return;

            const now = Date.now();
            const COACTIVATION_BUFFER_THRESHOLD = 50;
            const shouldFlush = coactBuf.length >= COACTIVATION_BUFFER_THRESHOLD || (now - lastFlushTime) > COACTIVATION_FLUSH_INTERVAL;

            if (!shouldFlush) return;

            // Process a chunk of coactivations to avoid blocking the event loop
            const pairs = coactBuf.splice(0, 50);
            if (pairs.length === 0) return;
            lastFlushTime = Date.now();

            await processCoactivations(pairs);
        },
        1000,
    );
};

export const stopHsgMaintenance = async () => {
    if (hsgIntervalId) {
        unregisterInterval(hsgIntervalId);
        hsgIntervalId = null;
    }
    // Flush remaining buffer
    if (coactBuf.length > 0) {
        logger.info(`[HSG] Flushing ${coactBuf.length} coactivations on shutdown...`);
        await flushCoactivations();
    }
};

async function flushCoactivations() {
    if (coactBuf.length === 0) return;
    const pairs = coactBuf.splice(0, coactBuf.length); // Flush all
    lastFlushTime = Date.now();
    await processCoactivations(pairs);
}

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
    const uid = normalizeUserId(f?.userId) ?? null;
    try {
        // Stable cache key generation
        const stableFilter = f
            ? Object.keys(f)
                .sort()
                .reduce((obj, key) => {
                    if (key === "userId") {
                        obj[key] = uid;
                    } else {
                        obj[key] = (f as Record<string, unknown>)[key];
                    }
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
        const sr = await Embedder.embedQueryForAllSectors(qt, primarySectors).catch((e) => {
            // REDACTION: Do not log raw query text
            logger.warn(`[HSG] Embedding failed for query (len=${qt.length}), falling back to keyword search:`, { error: e });
            return null;
        });

        if (!sr) {
            // Fallback to keyword search
            const memories = await q.searchMemsByKeyword.all(qt, k, uid);
            if (memories.length === 0) return [];

            // Process keyword matches into HsgQueryResult format
            const enc = Security.getEncryption();
            const { hydrateMemoryRow } = await import("./utils"); // Lazy import to avoid cycle if any (though utils is leaf)

            const results: HsgQueryResult[] = await Promise.all(memories.map(async (m: MemoryRow) => {
                const content = await enc.decrypt(m.content || "");
                const hyd = hydrateMemoryRow(m);

                return {
                    ...hyd,
                    content: content || "",
                    score: 0.5,
                    path: [m.id],
                    sectors: [m.primarySector],
                    metadata: hyd.metadata,
                    tags: hyd.tags
                } as HsgQueryResult;
            }));
            const final = { r: results, t: Date.now() };
            cache.set(h, final);
            return results;
        }

        const queryWeights = getSectorWeights();
        const qe: Record<string, number[]> = {};
        for (const r of sr) qe[r.sector] = r.vector;
        const candidates = new Map<string, { vectorScore: number; searchSector: string }>();
        const results: HsgQueryResult[] = [];

        // 1. Gather Candidates (Parallel Search, limited concurrency)
        const searchPromises = sr.map(async (srItem) => {
            const matches = await vectorStore.searchSimilar(
                srItem.sector,
                srItem.vector,
                k * 2,
                uid,
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

        // 2. Batch Fetch Memories and Vectors with DB-side filtering
        const [memories, allVectors] = await Promise.all([
            q.hsgSearch.all(
                candidateIds,
                uid,
                candidateIds.length, // Fetch all candidates to allow full fusion ranking
                f?.startTime,
                f?.endTime,
                f?.minSalience,
                hybridParams.tau
            ),
            vectorStore.getVectorsByIds(candidateIds, uid),
        ]);

        // Index vectors by Memory ID
        const vectorsMap = new Map<string, Array<{ sector: string; vector: number[] }>>();
        for (const v of allVectors) {
            if (!vectorsMap.has(v.id)) vectorsMap.set(v.id, []);
            vectorsMap.get(v.id)!.push(v);
        }

        // PRE-CALCULATE PATHS using multi-root Spreading Activation
        const pathMap = new Map<string, { path: string[]; weight: number }>();
        const spreadResults = await spreadingActivation(candidateIds, 100, uid);

        for (const sp of spreadResults) {
            // Only use if not already better path recorded (though spreadingActivation internal map handles this)
            pathMap.set(sp.id, { path: sp.path, weight: sp.weight });
        }

        const enc = Security.getEncryption();

        // 3. Process Candidates in Memory
        await Promise.all(memories.map(async (m: MemoryRow) => {
            const cand = candidates.get(m.id);
            if (!cand) return;

            const decryptedContent = await enc.decrypt(m.content || "");
            if (!decryptedContent && m.content) {
                logger.warn(`[HSG] Decryption produced empty content for memory ${m.id}`);
                return;
            }

            // Calculate Fusion Score (In-Memory)
            const mVecs = vectorsMap.get(m.id) || [];
            let sum = 0, tot = 0;

            for (const v of mVecs) {
                if (!qe[v.sector]) continue;
                const sim = cosineSimilarity(qe[v.sector], v.vector);
                const wgt = queryWeights[v.sector] || 0.5;
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
            const sal = calcDecay(m.primarySector, m.salience || 0.5, age, m.decayLambda);

            const tokOv = computeTokenOverlap(
                qtk,
                canonicalTokenSet(decryptedContent || ""),
            );
            const pathInfo = pathMap.get(m.id) || { path: [m.id], weight: 0 };
            const recSc = calculateRecencyScore(m.lastSeenAt || 0, hybridParams.tau);
            const hs = computeHybridScore(
                cand.vectorScore,
                tokOv,
                pathInfo.weight,
                recSc,
                0,
                await computeTagMatchScore(m, qtk),
                sal, // Use calculated (decayed) salience
            );

            results.push({
                id: m.id,
                content: decryptedContent || "",
                score: hs * resonance,
                sectors: mVecs.map(v => v.sector),
                primarySector: m.primarySector,
                path: pathInfo.path,
                salience: sal,
                lastSeenAt: m.lastSeenAt || 0,
                createdAt: m.createdAt || 0,
                tags: m.tags || [],
                metadata: parseJSON(m.metadata || {}),
                updatedAt: m.updatedAt || 0,
                decayLambda: m.decayLambda,
                version: m.version,
                segment: m.segment,
                simhash: m.simhash,
                generatedSummary: m.generatedSummary,
                userId: m.userId ?? null,
            } as HsgQueryResult);
        }));

        results.sort((a, b) => b.score - a.score);
        const top = results.slice(0, k);

        // Populate Coactivation Buffer
        if (top.length > 1) {
            for (let i = 0; i < top.length; i++) {
                for (let j = i + 1; j < Math.min(top.length, 5); j++) {
                    if (coactBuf.length < 500) {
                        const exists = coactBuf.some(p => p[1] === top[i].id && p[2] === top[j].id);
                        if (!exists) {
                            coactBuf.push([
                                normalizeUserId(f?.userId) ?? undefined,
                                top[i].id,
                                top[j].id,
                            ]);
                        }
                    }
                }
            }
        }

        for (const r of top) {
            onQueryHit(r.id, r.primarySector, uid, async (text) => {
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
    } finally {
        decQ();
    }
}

/**
 * Establishes bidirectional semantic links between memories in the same sector.
 */
export async function createInterMemWaypoints(
    newId: string,
    primSec: string,
    newVec: number[],
    userId?: string | null,
): Promise<void> {
    const uid = normalizeUserId(userId) ?? null;
    const thresh = 0.85; // High precision threshold
    const wt = 0.5;
    const nowTs = Date.now();

    // Find similar memories in the same sector and user scope
    // We use the vector store for efficient lookups instead of full table scan
    const similar = await vectorStore.searchSimilar(primSec, newVec, 50, uid);
    const updates: Array<{ srcId: string; dstId: string; userId: string | null; weight: number; createdAt: number; updatedAt: number }> = [];

    for (const match of similar) {
        if (match.id === newId || match.score < thresh) continue;
        updates.push({
            srcId: newId,
            dstId: match.id,
            userId: uid ?? null,
            weight: wt,
            createdAt: nowTs,
            updatedAt: nowTs,
        });
        updates.push({
            srcId: match.id,
            dstId: newId,
            userId: uid ?? null,
            weight: wt,
            createdAt: nowTs,
            updatedAt: nowTs,
        });
    }

    if (updates.length > 0) {
        await q.insWaypoints.run(updates);
    }
}

/**
 * Creates a "Semantic Gravity" link between a new memory and its most similar predecessor.
 * Now uses vector similarity search for optimized retrieval.
 */
export async function createSemanticGravityLink(
    newId: string,
    meanVec: number[],
    userId?: string | null,
): Promise<void> {
    const uid = normalizeUserId(userId) ?? null;
    const nowTs = Date.now();

    // Use vector search to find the most relevant candidate(s)
    // Correct tool call: searchSimilar(sector, queryVec, topK, userId, filter)
    const results = await vectorStore.searchSimilar("semantic", meanVec, 5, uid);
    const bestCandidate = results.find(r => r.id !== newId);

    if (bestCandidate) {
        await q.insWaypoint.run(newId, bestCandidate.id, uid ?? null, bestCandidate.score || 0.8, nowTs, nowTs);
    } else {
        // First memory for user: self-link to establish root or handle isolation
        await q.insWaypoint.run(newId, newId, uid ?? null, 1.0, nowTs, nowTs);
    }
}

/**
 * Orchestrates graph linking operations for a new memory.
 */
async function graphLink(
    id: string,
    meanVec: number[],
    primarySector: string,
    userId?: string | null,
): Promise<void> {
    try {
        const uid = normalizeUserId(userId);
        await Promise.all([
            createSemanticGravityLink(id, meanVec, uid),
            createInterMemWaypoints(id, primarySector, meanVec, uid),
        ]);
    } catch (e) {
        logger.warn(`[HSG] Graph linking failed for memory ${id}:`, { error: e });
    }
}

/**
 * Adds a single memory item to the HSG.
 * Handles content classification, encryption, vector embedding, and graph linking.
 * 
 * @param content - The raw text content of the memory.
 * @param userId - The user ID to associate with the memory.
 * @param metadata - Optional metadata (tags, source, etc.).
 * @param overrides - Optional overrides for ID and creation time.
 * @returns The created MemoryItem.
 */
export async function addMemory(
    content: string,
    userId: string | undefined | null,
    metadata?: Record<string, unknown>,
    overrides?: { id?: string; createdAt?: number },
): Promise<MemoryItem> {
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
            const model = await LearnedClassifier.load(userId);
            if (model) {
                const vecRes = await Embedder.embedForSector(content, "semantic");

                // Predict
                const Pred = LearnedClassifier.predict(vecRes, model);

                // If high confidence, override
                if (Pred.confidence > env.classifierOverrideThreshold) {
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

    // Generate simhash for dedup and storage (Ticket #1, #13)
    const simhash = computeSimhash(content);

    // Idempotency / Deduplication Check (Only if no ID override)
    if (!overrides?.id) {
        const uidNormalized = normalizeUserId(userId) ?? null;
        const existing = await q.getMemBySimhash.get(simhash, uidNormalized);
        if (existing) {
            const enc = Security.getEncryption();
            const existingContent = await enc.decrypt(existing.content);

            // Only treat as duplicate if content actually matches
            if (existingContent === content) {
                logger.debug(`[HSG] Dedup: Memory already exists (${existing.id})`);
                await q.updSeen.run(
                    existing.id,
                    now,
                    Math.min(1.0, (existing.salience || 0.5) + 0.1),
                    now,
                    uidNormalized,
                );

                let parsedTags: string[] = [];
                try {
                    parsedTags = existing.tags ? JSON.parse(existing.tags) : [];
                } catch {
                    parsedTags = [];
                }

                let parsedMeta: Record<string, unknown> = {};
                try {
                    parsedMeta = existing.metadata ? JSON.parse(existing.metadata) : {};
                } catch {
                    parsedMeta = {};
                }

                return {
                    id: existing.id,
                    content: content,
                    primarySector: existing.primarySector,
                    tags: parsedTags,
                    metadata: parsedMeta,
                    userId: existing.userId,
                    segment: existing.segment || 0,
                    simhash: existing.simhash || simhash,
                    createdAt: existing.createdAt || now,
                    updatedAt: now,
                    lastSeenAt: now,
                    salience: Math.min(1.0, (existing.salience || 0.5) + 0.1),
                    decayLambda: existing.decayLambda || 0.005,
                    version: existing.version || 1,
                    generatedSummary: null,
                    sectors: [existing.primarySector],
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
        embRes = await Embedder.embedMultiSector(
            id,
            content,
            addSecs,
            undefined,
            userId || undefined,
        );
    } catch (e) {
        logger.error(`[HSG] Embedding failed for memory ${id}:`, { error: e });
        throw e;
    }

    const meanVec = calcMeanVec(embRes);
    const meanVecBuf = Buffer.from(vectorToUint8Array(meanVec));

    const salience = typeof metadata?.salience === "number" ? metadata.salience : Math.min(1.0, 0.4 + 0.1 * qc.additional.length);
    const decayLambda = typeof metadata?.decayLambda === "number"
        ? metadata.decayLambda
        : sectorConfigs[primSec].decayLambda;

    const enc = Security.getEncryption();
    const encryptedContent = await enc.encrypt(content);

    const safeJson = (obj: any) => {
        try {
            return JSON.stringify(obj);
        } catch {
            return "{}";
        }
    };

    // Execute in transaction for atomicity (DB + Vector Store)
    const memoryItem = await transaction.run(async () => {
        // 1. Insert into Main DB
        // Parameters: id, content, sector, tags, meta, userId, segment, simhash,
        //            ca, ua, lsa, salience, dl, version, dim, mv, cv, fs, summary
        await q.insMem.run(
            id,
            encryptedContent,
            primSec,
            safeJson(metadata?.tags || []),
            safeJson(metadata || {}),
            uid ?? null,
            0, // segment
            simhash,
            now, // created_at
            now, // updated_at
            now, // last_seen_at
            salience,
            decayLambda,
            1, // version
            meanVec.length, // dim
            meanVecBuf, // mean_vec
            meanVecBuf, // compressed_vec
            0, // feedback_score
            null, // generated_summary
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
            await createCrossSectorWaypoints(id, primSec, qc.additional, uid).catch((e) => {
                logger.warn(`[HSG] Failed to create cross-sector waypoints for ${id}:`, { error: e });
            });
        }

        // 4. Graph Linking (Gravity & Associative)
        await graphLink(id, meanVec, primSec, uid);

        return {
            id,
            content,
            primarySector: primSec,
            tags: (metadata?.tags as string[]) || [],
            metadata: metadata || {},
            userId: uid ?? null,
            segment: 0,
            simhash,
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
            salience,
            decayLambda,
            version: 1,
            generatedSummary: null,
            sectors: [primSec, ...qc.additional],
        } as MemoryItem;
    });

    eventBus.emit(EVENTS.MEMORY_ADDED, memoryItem);

    return memoryItem;
}

/**
 * Wrapper for addMemory that handles tag parsing from string or array.
 * 
 * @param content - The raw text content.
 * @param tagsOrStr - Tags as an array of strings or a JSON string.
 * @param metadata - Additional metadata.
 * @param userId - User ID.
 * @param overrides - ID/Time overrides.
 * @returns The created MemoryItem.
 */
export async function addHsgMemory(
    content: string,
    tagsOrStr?: string | string[] | null,
    metadata: Record<string, unknown> = {},
    userId?: string | null,
    overrides?: { id?: string; createdAt?: number },
): Promise<MemoryItem> {
    let tags: string[] = [];
    if (Array.isArray(tagsOrStr)) {
        tags = tagsOrStr;
    } else if (typeof tagsOrStr === "string") {
        try {
            tags = JSON.parse(tagsOrStr);
        } catch {
            tags = [];
        }
    } else {
        tags = (metadata?.tags as string[]) || [];
    }
    return await addMemory(content, userId, { ...metadata, tags }, overrides);
}

/**
 * Batch adds multiple memories to the HSG.
 * optimization: Uses parallel processing for embeddings and batched DB inserts.
 * 
 * @param items - Array of items with content and metadata.
 * @param userId - User ID used for all items.
 * @returns Array of objects containing the new IDs and their primary sectors.
 */
export async function addMemories(
    items: Array<{ content: string; metadata?: Record<string, unknown> }>,
    userId: string | undefined | null,
): Promise<Array<{ id: string; primarySector: string }>> {
    const now = Date.now();
    const enc = Security.getEncryption();
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
        qc: SectorClassification;
    }> = [];

    const EMBED_CHUNK_SIZE = 20; // Process 20 items at a time to avoid OOM
    for (let i = 0; i < processedItems.length; i += EMBED_CHUNK_SIZE) {
        const chunk = processedItems.slice(i, i + EMBED_CHUNK_SIZE);
        const chunkResults = await Promise.all(
            chunk.map(async (item) => {
                let qc = classifyContent(item.content, item.metadata);

                // Learned Refinement in Batch
                if (userId && qc.primary === "semantic") {
                    try {
                        const model = await LearnedClassifier.load(userId);
                        if (model) {
                            const vec = await Embedder.embedForSector(item.content, "semantic");
                            const pred = LearnedClassifier.predict(vec, model);
                            if (pred.confidence > 0.6) qc = pred;
                        }
                    } catch { }
                }

                const addSecs = [qc.primary, ...qc.additional];
                const embRes = await Embedder.embedMultiSector(
                    item.id,
                    item.content,
                    addSecs,
                    undefined,
                    uid,
                );
                const meanVec = calcMeanVec(embRes);

                return {
                    id: item.id,
                    embRes,
                    meanVec,
                    meanDim: meanVec.length,
                    qc,
                };
            }),
        );
        embeddingResults.push(...chunkResults);
    }

    // 3. Batch Main DB Insert
    const dbItems = processedItems.map((item, i) => {
        const emb = embeddingResults[i];
        const meanVecBuf = Buffer.from(vectorToUint8Array(emb.meanVec));
        return {
            id: item.id,
            content: item.encryptedContent,
            primarySector: emb.qc.primary,
            tags: JSON.stringify(item.metadata.tags || []),
            metadata: JSON.stringify(item.metadata),
            userId: uid ?? null,
            segment: 0,
            simhash: item.simhash,
            createdAt: item.createdAt,
            updatedAt: item.createdAt,
            lastSeenAt: item.createdAt,
            salience: Math.min(1.0, 0.4 + 0.1 * emb.qc.additional.length),
            decayLambda: sectorConfigs[emb.qc.primary].decayLambda,
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
            await vectorStore.storeVectors(vectorItems, uid);
        } catch (e) {
            logger.error(`[HSG] Batch vector storage failed for user ${userId}:`, { error: e });
            throw e; // Rollback DB
        }

        // 5. Batch Graph Linking
        for (const emb of embeddingResults) {
            await graphLink(emb.id, emb.meanVec, emb.qc.primary, uid);
        }

        return processedItems.map((p, i) => ({
            id: p.id,
            primarySector: embeddingResults[i].qc.primary,
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

/**
 * Reinforces a memory by increasing its salience (importance).
 * Also updates the "last seen" timestamp.
 * 
 * @param id - The ID of the memory to reinforce.
 * @param boost - Amount to increase salience by (default: 0.1).
 * @param userId - Optional User ID for scoping.
 */
export async function reinforceMemory(
    id: string,
    boost = 0.1,
    userId?: string | null,
) {
    const uid = normalizeUserId(userId) ?? null;
    const m = await q.getMem.get(id, uid);
    if (!m) throw new Error("Memory not found");
    const newSal = Math.min(1.0, (m.salience || 0.5) + boost);
    // Update salience
    await q.updSeen.run(
        id,
        m.lastSeenAt || Date.now(),
        newSal,
        Date.now(),
        uid,
    );

    // Ticket #17: Recalculate mean vector
    const vectors = await vectorStore.getVectorsById(id, uid);
    if (vectors.length > 0) {
        // Need to extract raw vectors
        const rawVecs = vectors.map(v => v.vector);
        const meanVec = aggregateVectors(rawVecs); // Basic mean
        const meanVecBuf = Buffer.from(vectorToUint8Array(meanVec));

        // Update mean vec in DB (updMeanVec takes: id, dim, mv, userId)
        await q.updMeanVec.run(id, meanVec.length, meanVecBuf, uid);
    }
}


/**
 * Updates an existing memory's content, tags, or metadata.
 * Re-calculates embeddings and sectors if content changes.
 * 
 * @param id - The ID of the memory to update.
 * @param content - New content (optional).
 * @param tags - New tags array (optional).
 * @param metadata - New metadata object (optional).
 * @param userId - Optional User ID (for permission check/scoping).
 * @returns Object indicating success.
 */
/**
 * Updates an existing memory with optional re-embedding.
 * Standardized to object-based signature for better flexibility and consistent parameter handling.
 * 
 * @param id - The unique ID of the memory.
 * @param updates - Object containing fields to update (content, tags, metadata, userId).
 * @returns Object indicating success.
 */
export async function updateMemory(
    id: string,
    updates: {
        content?: string,
        tags?: string[],
        metadata?: Record<string, any>,
        userId?: string | null,
    },
): Promise<MemoryRow | undefined> {
    const { content, tags, metadata, userId } = updates;
    const uid = normalizeUserId(userId) ?? null;
    const existing = await q.getMem.get(id, uid);
    if (!existing) return undefined;

    const newContent = content ?? existing.content;
    const newTags = tags ? JSON.stringify(tags) : existing.tags;
    const newMeta = metadata ? JSON.stringify(metadata) : existing.metadata;

    let finalContent = existing.content;
    let embRes: EmbeddingResult[] | null = null;
    let meanVecBuf: Buffer | null = null;
    let dim: number = 0;

    if (content !== undefined) {
        // 1. Prepare Data & Embeddings (No Side Effects)
        const qc = classifyContent(newContent, metadata);
        const addSecs = [qc.primary, ...qc.additional];
        const prob = await Embedder.embedMultiSector(
            id,
            newContent,
            addSecs,
            undefined,
            uid || undefined,
        );
        embRes = prob;
        // recalculate mean vector using the same physics as addMemory
        const meanVec = calcMeanVec(embRes);
        meanVecBuf = Buffer.from(vectorToUint8Array(meanVec));
        dim = meanVec.length;

        finalContent = await Security.getEncryption().encrypt(newContent);
    }

    // 3. Database & Vector Updates (Transactional)
    try {
        await transaction.run(async () => {
            // Update Vectors only if re-embedded
            if (embRes) {
                await vectorStore.deleteVectors([id], uid);
                // The provided diff snippet for `updateMemory` contained an `if (f?.startTime || f?.endTime)` block
                // which uses an undefined variable `f` and is syntactically incorrect in this context.
                // It has been omitted to maintain correctness.
                for (const res of embRes) {
                    await vectorStore.storeVector(
                        id,
                        res.sector,
                        res.vector,
                        res.dim,
                        uid || undefined,
                    );
                }
            }

            // Update Metadata / Mean Vector
            if (meanVecBuf && dim > 0) {
                await q.updMeanVec.run(id, dim, meanVecBuf, uid);
            }
            await q.updMem.run(
                finalContent,
                existing.primarySector,
                newTags || "",
                newMeta || "",
                Date.now(),
                id,
                uid,
            );
        });
    } catch (e) {
        logger.error(`[HSG] Update failed for memory ${id}:`, { error: e });
        throw e;
    }

    // 4. Return updated record
    return await q.getMem.get(id, uid);
}

/**
 * Prunes low-weight waypoints from the graph.
 * Uses weight threshold to remove weak connections.
 * @param userId - Optional user ID for scoping
 * @param threshold - Weight threshold below which waypoints are deleted (default: 0.1)
 */
export async function pruneWaypoints(
    userId?: string | null,
    threshold: number = 0.1,
): Promise<number> {
    // Use the repository's pruneWaypoints method which handles the deletion
    const deleted = await q.pruneWaypoints.run(threshold, userId);
    if (env.verbose) {
        logger.debug(`[HSG] Pruned ${deleted} weak waypoints (threshold: ${threshold})`);
    }
    return deleted;
}

/**
 * Alias for backward compatibility with maintenance.ts.
 * @param threshold - Weight threshold (default: 0.1)
 * @param userId - Optional user ID for scoping
 */
export async function pruneWeakWaypoints(
    threshold: number = 0.1,
    userId?: string | null,
): Promise<number> {
    return pruneWaypoints(userId, threshold);
}
