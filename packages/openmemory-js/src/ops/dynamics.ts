import { allAsync, pUser, q, sqlUser } from "../core/db";
import { vectorStore } from "../core/db";
import { MemoryRow } from "../core/types";
import { normalizeUserId, now } from "../utils";
import { logger } from "../utils/logger";
import { cosineSimilarity } from "../utils/vectors";

/**
 * Learning Rate for Recall Reinforcement.
 * How much salience increases when a memory is recalled.
 */
export const alphaLearningRateForRecallReinforcement = 0.15;
export const betaLearningRateForEmotionalFrequency = 0.2;
export const gammaAttenuationConstantForGraphDistance = 0.35;
export const thetaConsolidationCoefficientForLongTerm = 0.4;
export const etaReinforcementFactorForTraceLearning = 0.18;
export const lambdaOneFastDecayRate = 0.015;
export const lambdaTwoSlowDecayRate = 0.002;
// Energy threshold coefficient for retrieval activation
export const tauEnergyThresholdForRetrieval = 0.4;

export const sectoralInterdependenceMatrixForCognitiveResonance = [
    [1.0, 0.7, 0.3, 0.6, 0.6],
    [0.7, 1.0, 0.4, 0.7, 0.8],
    [0.3, 0.4, 1.0, 0.5, 0.2],
    [0.6, 0.7, 0.5, 1.0, 0.8],
    [0.6, 0.8, 0.2, 0.8, 1.0],
];

export const sectorIndexMappingForMatrixLookup: Record<string, number> = {
    episodic: 0,
    semantic: 1,
    procedural: 2,
    emotional: 3,
    reflective: 4,
    workspace: 1, // Fallback to semantic logic
    archived: 1, // Fallback to semantic logic
};

export interface DynamicSalienceWeightingParameters {
    initialSalienceValue: number;
    decayConstantLambda: number;
    recallReinforcementCount: number;
    emotionalFrequencyMetric: number;
}

export interface AssociativeWaypointGraphNode {
    nodeMemoryId: string;
    activationEnergyLevel: number;
    connectedWaypointEdges: Array<{
        targetNodeId: string;
        linkWeightValue: number;
        timeGapDeltaT: number;
    }>;
}

/**
 * Computes the logistic sigmoid function.
 * @param x Input value.
 * @returns Value in range (0, 1).
 */
export const sigmoid = (x: number): number => {
    // Prevent overflow for very large negative numbers
    if (x < -40) return 0;
    if (x > 40) return 1;
    return 1 / (1 + Math.exp(-x));
};

/**
 * Calculates a recency score based on time elapsed.
 * @param lastSeenAt Timestamp of last access.
 * @param tau Decay constant.
 * @param maxDays Maximum days for scoring window.
 * @returns Score in range (0, 1).
 */
export function calculateRecencyScore(lastSeenAt: number, tau = 0.5, maxDays = 60): number {
    const daysSince = (Date.now() - lastSeenAt) / 86400000;
    return Math.max(0, Math.exp(-daysSince / tau) * (1 - daysSince / maxDays));
}

/**
 * Calculates a link weight based on semantic and emotional scores.
 * @param semanticScore The semantic similarity score.
 * @param emotionalScore The emotional frequency or intensity score.
 * @param semanticWeight Weight coefficient for semantic component.
 * @param emotionalWeight Weight coefficient for emotional component.
 */
export const calculateLinkWeight = (
    semanticScore: number,
    emotionalScore: number,
    semanticWeight = 0.7,
    emotionalWeight = 0.3,
): number =>
    sigmoid(semanticWeight * semanticScore + emotionalWeight * emotionalScore);

/**
 * Calculates a dynamic salience value with time decay and reinforcement boosts.
 * Based on the forgetting curve memory model.
 */
export async function calculateDynamicSalienceWithTimeDecay(
    initialSalience: number,
    lambda: number,
    recallCount: number,
    emotionalFreq: number,
    timeDelta: number,
): Promise<number> {
    const decay = initialSalience * Math.exp(-lambda * timeDelta);
    const recallReinforcement =
        alphaLearningRateForRecallReinforcement * recallCount;
    const emotionalBoost =
        betaLearningRateForEmotionalFrequency * emotionalFreq;
    return Math.max(
        0,
        Math.min(1, decay + recallReinforcement + emotionalBoost),
    );
}

/**
 * Implements a dual-phase decay model: fast decay for recent memories, slow decay for consolidated ones.
 * @param initialSalience - The starting salience.
 * @param timeDeltaDays - Time elapsed since last recall/update in days.
 * @param customLambda - Optional override for slow decay phase.
 */
export function calculateDualPhaseDecayMemoryRetention(
    initialSalience: number,
    timeDeltaDays: number,
    customLambda?: number,
): number {
    const lambdaTwo = customLambda ?? lambdaTwoSlowDecayRate;
    const theta = thetaConsolidationCoefficientForLongTerm;

    const fastDecay = Math.exp(-lambdaOneFastDecayRate * timeDeltaDays);
    const slowDecay = Math.exp(-lambdaTwo * timeDeltaDays);

    // Weighted sum ensures retention factor is 1.0 at t=0
    const retentionFactor = (1 - theta) * fastDecay + theta * slowDecay;

    return Math.max(0, Math.min(initialSalience, initialSalience * retentionFactor));
}

/**
 * Calculates an associative link weight between two vectors, attenuated by time.
 */
export async function calculateAssociativeWaypointLinkWeight(
    sourceVec: number[],
    targetVec: number[],
    timeGapMs: number,
): Promise<number> {
    const sim = cosineSimilarity(sourceVec, targetVec);
    const timeDeltaDays = timeGapMs / 86400000;
    return Math.max(0, sim / (1 + timeDeltaDays));
}

/**
 * Calculates the spreading activation energy for a specific node based on its neighbors.
 */
export async function calculateSpreadingActivationEnergy(
    nodeId: string,
    activationMap: Map<string, number>,
    graph: Map<string, AssociativeWaypointGraphNode>,
): Promise<number> {
    const node = graph.get(nodeId);
    if (!node) return 0;
    let totalEnergy = 0;
    for (const edge of node.connectedWaypointEdges) {
        const neighborActivation = activationMap.get(edge.targetNodeId) || 0;
        // Apply attenuation based on graph distance (1 hop here)
        const attenuation = Math.exp(
            -gammaAttenuationConstantForGraphDistance * 1,
        );
        totalEnergy += edge.linkWeightValue * neighborActivation * attenuation;
    }
    return totalEnergy;
}

/**
 * Applies reinforcement to a memory based on a retrieval trace.
 */
export async function applyRetrievalTraceReinforcement(
    _memoryId: string,
    salience: number,
): Promise<number> {
    return Math.min(
        1,
        salience + etaReinforcementFactorForTraceLearning * (1 - salience),
    );
}

/**
 * Propagates associative reinforcement from a source memory to its linked neighbors.
 */
export async function propagateReinforcementToNeighbors(
    _memoryId: string,
    sourceSalience: number,
    waypoints: Array<{ targetId: string; weight: number }>,
    userId?: string | null,
): Promise<Array<{ nodeId: string; newSalience: number }>> {
    if (waypoints.length === 0) return [];

    const targetIds = waypoints.map((wp) => wp.targetId);
    const uid = normalizeUserId(userId);
    const memories = await q.getMems.all(targetIds, uid);
    const updates: Array<{ nodeId: string; newSalience: number }> = [];

    for (const wp of waypoints) {
        const memory = memories.find((m) => m.id === wp.targetId);
        if (memory) {
            const propagationAmount =
                etaReinforcementFactorForTraceLearning *
                wp.weight *
                sourceSalience;
            updates.push({
                nodeId: wp.targetId,
                newSalience: Math.min(
                    1,
                    (memory.salience || 0) + propagationAmount,
                ),
            });
        }
    }
    return updates;
}

/**
 * Computes a resonance score between two cognitive sectors.
 */
export async function calculateCrossSectorResonance(
    memorySector: string,
    querySector: string,
    baseScore: number,
): Promise<number> {
    const s = memorySector?.toLowerCase() || "semantic";
    const qSector = querySector?.toLowerCase() || "semantic";
    const sourceIndex = sectorIndexMappingForMatrixLookup[s] ?? 1;
    const targetIndex = sectorIndexMappingForMatrixLookup[qSector] ?? 1;
    return (
        baseScore *
        sectoralInterdependenceMatrixForCognitiveResonance[sourceIndex][
        targetIndex
        ]
    );
}

/**
 * Determines an energy-based threshold for memory retrieval.
 */
export async function determineEnergyBasedRetrievalThreshold(
    activation: number,
    tau: number,
): Promise<number> {
    const norm = Math.max(0.1, activation);
    return Math.max(0.1, Math.min(0.9, tau * (1 + Math.log(norm + 1))));
}

/**
 * Applies the dual-phase decay model to all memories in the system.
 * Designed to be run periodically (e.g., hourly/daily).
 *
 * @param userId - Optional user ID to scope the decay operation.
 * @returns The number of memories processed.
 */
export async function applyDualPhaseDecayToAllMemories(
    userId?: string | null,
): Promise<number> {
    const chunkSize = 1000;
    let totalProcessed = 0;
    const ts = now();

    let cursor: { createdAt: number; id: string } | null = null;
    const uid = userId === undefined ? undefined : normalizeUserId(userId);

    while (true) {
        // Use cursor-based pagination for O(1) fetch performance
        const mems = (await q.allMemCursor.all(
            chunkSize,
            cursor,
            uid,
        )) as MemoryRow[];

        if (mems.length === 0) break;

        const updates = [];
        let lastMem: MemoryRow | null = null;

        for (const m of mems) {
            lastMem = m;
            const timeDeltaMs = Math.max(
                0,
                ts - (m.lastSeenAt || m.updatedAt || 0),
            );
            const timeDeltaDays = timeDeltaMs / 86400000;
            const newSalience = calculateDualPhaseDecayMemoryRetention(
                m.salience || 0,
                timeDeltaDays,
            );

            // Preserve original lastSeenAt during decay to avoid resetting the decay clock.
            // Only salience and updatedAt are refreshed during this operation.

            updates.push({
                id: m.id,
                salience: Math.max(0, newSalience),
                lastSeenAt: m.lastSeenAt || 0, // Preserve original
                updatedAt: ts, // Mark as updated now
            });
        }

        if (updates.length > 0) {
            await q.updSaliences.run(updates, uid);
        }

        totalProcessed += mems.length;

        // Update cursor for next batch
        if (lastMem && lastMem.createdAt !== undefined) {
            cursor = { createdAt: lastMem.createdAt, id: lastMem.id };
        } else {
            break; // Should not happen if query is correct
        }

        // Safety break if less than chunk size returned (End of results)
        if (mems.length < chunkSize) break;
    }

    logger.info(`[DECAY] Applied to ${totalProcessed} memories`);
    return totalProcessed;
}

export async function buildAssociativeWaypointGraphFromMemories(
    userId?: string | null,
    limit: number = 50000,
): Promise<Map<string, AssociativeWaypointGraphNode>> {
    const uid = normalizeUserId(userId);
    const graph = new Map<string, AssociativeWaypointGraphNode>();
    const safeLimit = Math.min(Math.max(1, limit), 50000); // Enforce max cap
    const sql = sqlUser(
        `select src_id as srcId, dst_id as dstId, weight, created_at as createdAt from waypoints`,
        uid,
    );
    const allWps = await allAsync<{
        srcId: string;
        dstId: string;
        weight: number;
        createdAt: number;
    }>(`${sql} order by created_at desc limit ${safeLimit}`, pUser([], uid));

    if (allWps.length >= safeLimit) {
        logger.warn(
            `[Dynamics] Graph load truncated at ${limit} edges. Spreading activation may be incomplete.`,
            { limit },
        );
    }

    const ids = new Set<string>();
    for (const wp of allWps) {
        ids.add(wp.srcId);
        ids.add(wp.dstId);
    }
    for (const id of ids)
        graph.set(id, {
            nodeMemoryId: id,
            activationEnergyLevel: 0,
            connectedWaypointEdges: [],
        });
    for (const wp of allWps) {
        const sourceNode = graph.get(wp.srcId);
        if (sourceNode) {
            const timeGap = Math.abs(now() - wp.createdAt);
            sourceNode.connectedWaypointEdges.push({
                targetNodeId: wp.dstId,
                linkWeightValue: wp.weight,
                timeGapDeltaT: timeGap,
            });
        }
    }
    return graph;
}

/**
 * Performs iterative spreading activation retrieval across the associative waypoint graph.
 * This simulates cognitive priming by activating neighbors of the query candidates.
 * 
 * @param initIds - Initial "seed" memory IDs to start activation from.
 * @param maxIterations - Number of hops (iterations) to perform.
 * @param userId - Optional user ID for tenant isolation.
 * @returns Map of Memory ID to its computed activation energy.
 */
export async function performSpreadingActivationRetrieval(
    initIds: string[],
    maxIterations: number,
    userId?: string | null,
): Promise<Map<string, number>> {
    const uid = userId === undefined ? undefined : normalizeUserId(userId);
    const activation = new Map<string, number>();
    for (const id of initIds) activation.set(id, 1.0);

    // Keep track of processed nodes to avoid redundant DB calls in the same iteration
    // Keep track of processed nodes to avoid redundant DB calls in the same iteration
    const MAX_ACTIVATED_NODES = 2000;

    // Safety: Global budget for edge traversals to prevent DoS
    let traversalBudget = 10000;

    for (let i = 0; i < maxIterations; i++) {
        // Sort by energy to prioritize high-energy propagation if we hit limits
        const currentBatch = Array.from(activation.entries())
            .filter(([_, energy]) => energy >= 0.05)
            .sort((a, b) => b[1] - a[1]);

        if (currentBatch.length === 0) break;

        // Safety cap: If too many nodes, only propagate from top 500 energy sources
        const processingBatch = currentBatch.slice(0, 500);
        const batchIds = processingBatch.map(([id]) => id);
        const allNeighbors: Array<{
            srcId: string;
            dstId: string;
            weight: number;
        }> = [];

        // Check budget before DB calls
        if (traversalBudget <= 0) {
            logger.warn("[Dynamics] Spreading activation halted: Traversal budget exceeded.");
            break;
        }

        // Chunking to avoid SQL parameter limits (e.g. 999 in SQLite/Postgres)
        const CHUNK_SIZE = 500;
        for (let j = 0; j < batchIds.length; j += CHUNK_SIZE) {
            if (traversalBudget <= 0) break;

            const chunk = batchIds.slice(j, j + CHUNK_SIZE);
            const chunkParams = chunk.map(() => "?").join(",");
            const chunkNeighbors = await q.getWaypointsBySrc.all(chunk, uid);

            allNeighbors.push(...chunkNeighbors);
            traversalBudget -= chunkNeighbors.length;
        }

        // Group by srcId for processing
        const neighborMap = new Map<
            string,
            Array<{ dstId: string; weight: number }>
        >();
        for (const n of allNeighbors) {
            if (!neighborMap.has(n.srcId)) neighborMap.set(n.srcId, []);
            neighborMap
                .get(n.srcId)!
                .push({ dstId: n.dstId, weight: n.weight });
        }

        const updates = new Map<string, number>();

        for (const [nodeId, currentEnergy] of currentBatch) {
            const neighbors = neighborMap.get(nodeId) || [];
            for (const neighbor of neighbors) {
                const attenuation = Math.exp(
                    -gammaAttenuationConstantForGraphDistance * (i + 1),
                );
                const propagatedEnergy =
                    neighbor.weight * currentEnergy * attenuation;

                const existing = updates.get(neighbor.dstId) || 0;
                updates.set(neighbor.dstId, existing + propagatedEnergy);
            }
        }

        let changed = false;
        for (const [targetId, newActivation] of updates) {
            const current = activation.get(targetId) || 0;
            if (newActivation > current) {
                activation.set(targetId, newActivation);
                changed = true;
            }
        }

        if (!changed) break;

        // Hard Limit check
        if (activation.size > MAX_ACTIVATED_NODES) {
            // Prune low energy nodes
            const sorted = Array.from(activation.entries()).sort((a, b) => b[1] - a[1]);
            activation.clear();
            for (const [id, en] of sorted.slice(0, MAX_ACTIVATED_NODES)) {
                activation.set(id, en);
            }
        }
    }
    return activation;
}

/**
 * Retrieves memories using hybrid dynamic scoring: vector similarity, resonance, and spreading activation.
 * To maintain scalability, it first retrieves a candidate set via vector search.
 */
export async function retrieveMemoriesWithEnergyThresholding(
    queryVec: number[],
    querySector: string,
    maxEnergy: number,
    userId?: string | null,
    candidateLimit = 100,
): Promise<(MemoryRow & { activationEnergy: number })[]> {
    // 1. Get candidate set via vector search to ensure scalability
    const uid = normalizeUserId(userId);
    const candidates = await vectorStore.searchSimilar(
        querySector,
        queryVec,
        candidateLimit,
        uid,
    );
    if (candidates.length === 0) return [];

    const candidateIds = candidates.map((c) => c.id);
    const mems = await q.getMems.all(candidateIds, uid);

    const scores = new Map<string, number>();
    for (const m of mems) {
        const cand = candidates.find((c) => c.id === m.id);
        const baseScore = cand?.score || 0;
        const resonanceScore = await calculateCrossSectorResonance(
            m.primarySector,
            querySector,
            baseScore,
        );
        scores.set(m.id, resonanceScore * (m.salience || 0));
    }

    // 2. Perform spreading activation from top candidates
    const topCandidates = Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map((e) => e[0]);

    const spreadingActivation = await performSpreadingActivationRetrieval(
        topCandidates,
        3,
        uid,
    );

    // 3. Combine scores and apply energy thresholding
    const combinedScores = new Map<string, number>();
    for (const m of mems) {
        const spreadScore = (spreadingActivation.get(m.id) || 0) * 0.3;
        combinedScores.set(m.id, (scores.get(m.id) || 0) + spreadScore);
    }

    const totalEnergy = Array.from(combinedScores.values()).reduce(
        (sum, val) => sum + val,
        0,
    );
    const threshold = await determineEnergyBasedRetrievalThreshold(
        totalEnergy,
        maxEnergy,
    );

    return mems
        .filter((m) => (combinedScores.get(m.id) || 0) > threshold)
        .map((m) => ({ ...m, activationEnergy: combinedScores.get(m.id)! }));
}

export const applyDecay = applyDualPhaseDecayToAllMemories;
