/**
 * @file consolidation.ts
 * @description Implements structural memory consolidation (Fading).
 * Handles vector compression for "cold" memories and text summarization to save space
 * and improve retrieval performance for older, less relevant data.
 */

import { env } from "../core/cfg";
import { q, vectorStore } from "../core/db";
import { sectorConfigs } from "../core/hsgConfig";
import { getEncryption } from "../core/security";
import { MemoryRow } from "../core/types";
import { normalizeUserId } from "../utils";
import { logger } from "../utils/logger";
import { summarizeQuick, topKeywords } from "../utils/text";
import { resizeVector } from "../utils/vectors";
import { calculateDualPhaseDecayMemoryRetention } from "../ops/dynamics";

// Subset of MemoryRow required for consolidation processing
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
    | "generatedSummary"
> & {
    coactivations?: number;
};

// Configuration derived strictly from central env
const cfg = {
    coldThreshold: env.decayColdThreshold,
    maxVecDim: env.maxVectorDim,
    minVecDim: env.minVectorDim,
    summaryLayers: env.summaryLayers,
    cooldown: 60000,
};

// --- Helpers ---

const clampF = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const clampI = (v: number, a: number, b: number) =>
    Math.min(b, Math.max(a, Math.floor(v)));
const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => 
    typeof Bun !== "undefined" && Bun.sleep
        ? Bun.sleep(ms)
        : new Promise((r) => setTimeout(r, ms));

let lastConsolidation = 0;

/**
 * Fingerprints a memory using top keywords and a SimHash-like deterministic vector.
 * Used when a memory is too cold to justify keeping its original embedding.
 */
const fingerprintMem = (
    m: DecayingMemory,
    decryptedContent: string,
): { vector: number[]; summary: string } => {
    const text = m.generatedSummary || decryptedContent || "";
    const base = `${m.id}|${text}`;

    // Deterministic projection for "cold" memories
    const vec = hashToVec(base, 32);
    const summary = topKeywords(text, 3).join(" ");
    return { vector: vec, summary };
};

// Simple deterministic vector generation from string
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
    // Normalize output
    let mag = 0;
    for (const v of out) mag += v * v;
    mag = Math.sqrt(mag) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= mag;
    return out;
};

/**
 * Progressively compresses text summary based on forgetting factor f.
 */
const compressSummary = (txt: string, f: number, layers = 3): string => {
    const t = (txt || "").trim();
    if (!t) return "";

    const lay = clampI(layers, 1, 3);
    const trunc = (s: string, n: number) =>
        s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";

    if (f > 0.8) return trunc(t, 200);
    if (f > 0.4) return trunc(summarizeQuick(t), lay >= 2 ? 80 : 200);
    return topKeywords(t, lay >= 3 ? 5 : 3).join(" ");
};

/**
 * Main consolidation process. Iterates through memories and applies
 * structural changes (vector compression, summarization) to those that are fading.
 */
export const consolidateStructuralMemory = async (
    userId?: string | null,
): Promise<{ decayed: number; processed: number }> => {
    const uid = normalizeUserId(userId);

    // Ensure database is ready before accessing q object
    const { waitForDb } = await import("../core/db/population");
    await waitForDb();

    const now = Date.now();
    if (now - lastConsolidation < cfg.cooldown) {
        if (env.verbose)
            logger.info(
                `[CONSOLIDATION] skipped - cooldown active (${((cfg.cooldown - (now - lastConsolidation)) / 1000).toFixed(0)}s remaining)`,
            );

        return { decayed: 0, processed: 0 };
    }

    lastConsolidation = now;
    const t0 = performance.now();

    const segments = await q.getSegments.all(uid);
    if (!segments || segments.length === 0) return { decayed: 0, processed: 0 };

    let totProc = 0,
        totChg = 0,
        totComp = 0,
        totFp = 0;

    for (const seg of segments) {
        const segment = seg.segment;
        const countRes = await q.getSegmentCount.get(segment, uid);
        const total = countRes?.c || 0;

        if (total === 0) continue;

        // Process a ratio of the segment to keep background load predictable
        const batchSz = Math.max(1, Math.floor(total * env.decayRatio));
        const startIdx = Math.floor(Math.random() * Math.max(1, total - batchSz));

        const rows = await q.allMem.all(batchSz, startIdx, uid);
        const batch = rows as MemoryRow[];
        const memIds = batch.map((m) => m.id);

        // Fetch existing vectors for comparison/compression
        const vectors = await vectorStore.getVectorsByIds(memIds, uid);
        const vectorMap = new Map(vectors.map((v) => [`${v.id}:${v.sector}`, v]));

        const summaryUpdates: Array<{ id: string; summary: string }> = [];
        const salUpdates: Array<{ id: string; salience: number; lastSeenAt: number; updatedAt: number }> = [];
        const vectorStoreUpdates: Array<{ id: string; sector: string; vector: number[]; dim: number }> = [];
        const vectorStoreDeletes: Array<{ id: string; sector: string }> = [];

        for (const m of batch) {
            const last = m.lastSeenAt || m.updatedAt || now;
            const timeDeltaDays = Math.max(0, now - last) / 86400000;

            // Calculate effective salience using the central dynamics model
            const currentSal = calculateDualPhaseDecayMemoryRetention(
                m.salience || 0.5,
                timeDeltaDays,
                m.decayLambda || undefined
            );

            // f = Forgetting Factor (0.0 to 1.0)
            const f = clampF(currentSal / ((m.salience || 0.5) + 1e-9), 0, 1);

            let structuralChange = false;

            // Only perform expensive structural changes if significant fading has occurred
            if (f < 0.7) {
                const sector = m.primarySector || "semantic";
                let vecRow = vectorMap.get(`${m.id}:${sector}`);
                let isCold = false;

                if (!vecRow) {
                    vecRow = vectorMap.get(`${m.id}:${sector}_cold`);
                    isCold = true;
                }

                const enc = getEncryption();
                const decryptedContent = await enc.decrypt(m.content || "");

                if (vecRow && vecRow.vector) {
                    const vec = Array.isArray(vecRow.vector) ? vecRow.vector : [];
                    const beforeLen = vec.length;

                    if (beforeLen > 0) {
                        // 1. Vector Compression (Dimensionality Reduction)
                        const tgtDim = Math.max(
                            cfg.minVecDim,
                            Math.min(cfg.maxVecDim, Math.floor(beforeLen * clampF(f, 0.0, 1.0))),
                        );

                        if (tgtDim < beforeLen) {
                            const newVec = resizeVector(vec, tgtDim);
                            const targetSector = sector + "_cold";

                            vectorStoreUpdates.push({
                                id: m.id,
                                sector: targetSector,
                                vector: newVec,
                                dim: newVec.length,
                            });

                            if (!isCold) {
                                vectorStoreDeletes.push({ id: m.id, sector: sector });
                            }
                            totComp++;
                            structuralChange = true;
                        }

                        // 2. Summary Compression
                        const newSummary = compressSummary(
                            m.generatedSummary || decryptedContent,
                            f,
                            cfg.summaryLayers,
                        );

                        if (newSummary !== (m.generatedSummary || "")) {
                            summaryUpdates.push({ id: m.id, summary: newSummary });
                            structuralChange = true;
                        }
                    }
                }

                // 3. Fingerprinting (Extreme compression for almost-forgotten items)
                if (f < Math.max(0.3, cfg.coldThreshold)) {
                    const fp = fingerprintMem(m, decryptedContent);
                    const targetSector = sector + "_cold";

                    vectorStoreUpdates.push({
                        id: m.id,
                        sector: targetSector,
                        vector: fp.vector,
                        dim: fp.vector.length,
                    });

                    vectorStoreDeletes.push({ id: m.id, sector: sector });
                    summaryUpdates.push({ id: m.id, summary: fp.summary });
                    totFp++;
                    structuralChange = true;
                }
            }

            // Sync salience if structural change was made or if it diverged significantly
            const divergence = Math.abs(currentSal - (m.salience || 0));
            if (structuralChange || divergence > 0.1) {
                salUpdates.push({
                    id: m.id,
                    salience: currentSal,
                    lastSeenAt: m.lastSeenAt || now,
                    updatedAt: now,
                });
                totChg++;
            }
            totProc++;
        }

        // Execute batch updates
        if (salUpdates.length > 0) await q.updSaliences.run(salUpdates, uid);
        if (summaryUpdates.length > 0) await q.updSummaries.run(summaryUpdates, uid);
        if (vectorStoreUpdates.length > 0) await vectorStore.storeVectors(vectorStoreUpdates, uid);
        for (const del of vectorStoreDeletes) await vectorStore.deleteVector(del.id, del.sector, uid);

        await tick();
        if (seg !== segments[segments.length - 1]) {
            await sleep(env.decaySleepMs);
        }
    }

    const duration = performance.now() - t0;
    if (env.verbose && totProc > 0) {
        logger.info(
            `[CONSOLIDATION] ${totChg}/${totProc} structural updates | compressed=${totComp} fingerprinted=${totFp} | ${duration.toFixed(1)}ms`,
        );
    }
    return { decayed: totChg, processed: totProc };
};

/**
 * Handles memory reinforcement and regeneration when a memory is accessed (Queried).
 * Increases salience (LTP) and triggers re-embedding if the memory was in cold storage.
 */
export const onQueryHit = async (
    memId: string,
    sector: string,
    userId?: string | null,
    reembed?: (text: string) => Promise<number[]>,
) => {
    const uid = normalizeUserId(userId);
    // Configuration check: only proceed if reinforcement or regeneration is enabled
    if (!env.regenerationEnabled && !env.decayReinforceOnQuery) return;

    const m = await q.getMem.get(memId, uid);
    if (!m) return;

    let updated = false;

    // 1. Structural Regeneration (Move back to hot storage if accessed)
    if (env.regenerationEnabled && reembed) {
        let vecRow = await vectorStore.getVector(memId, sector, uid);

        // If memory is only in cold storage, re-embed it to "warm" it up
        if (!vecRow) {
            vecRow = await vectorStore.getVector(memId, sector + "_cold", uid);
        }

        if (vecRow && vecRow.vector) {
            const vec = vecRow.vector;
            // Only re-generate if the vector is significantly compressed
            if (Array.isArray(vec) && vec.length <= 64) {
                try {
                    const enc = getEncryption();
                    const decryptedContent = await enc.decrypt(m.content || "");
                    const newVec = await reembed(decryptedContent);

                    // Restore to original sector
                    await vectorStore.storeVector(
                        memId,
                        sector,
                        newVec,
                        newVec.length,
                        uid,
                    );
                    // Remove from cold storage
                    await vectorStore.deleteVector(memId, sector + "_cold", uid);
                    updated = true;
                } catch (e) {
                    logger.debug(`[REGENERATION] Re-embed failed for ${memId}:`, {
                        error: e,
                    });
                }
            }
        }
    }

    // 2. Salience Reinforcement (Long-Term Potentiation)
    if (env.decayReinforceOnQuery) {
        // Boost salience by 10% (capped at 1.0)
        const newSal = clampF((m.salience || 0.5) + 0.1, 0, 1);
        await q.updSeen.run(memId, Date.now(), newSal, Date.now(), uid);
        updated = true;
    }

    if (updated && env.verbose) {
        logger.info(`[REINFORCEMENT] regenerated/reinforced memory ${memId} in sector ${sector}`);
    }
};

// Aliases for backward compatibility
// Aliases for backward compatibility
export const applyDecay = consolidateStructuralMemory;

// Simple query load tracking
let activeQueries = 0;
export const incQ = () => { activeQueries++; };
export const decQ = () => { if (activeQueries > 0) activeQueries--; };
