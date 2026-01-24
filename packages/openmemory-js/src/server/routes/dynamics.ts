
import { Elysia } from "elysia";
import { z } from "zod";
import { q } from "../../core/db";
import { getUser, verifyUserAccess } from "../middleware/auth";
import { normalizeUserId } from "../../utils";
import {
    alphaLearningRateForRecallReinforcement,
    betaLearningRateForEmotionalFrequency,
    buildAssociativeWaypointGraphFromMemories,
    calculateAssociativeWaypointLinkWeight,
    calculateCrossSectorResonance,
    calculateDynamicSalienceWithTimeDecay,
    etaReinforcementFactorForTraceLearning,
    gammaAttenuationConstantForGraphDistance,
    lambdaOneFastDecayRate,
    lambdaTwoSlowDecayRate,
    performSpreadingActivationRetrieval,
    propagateReinforcementToNeighbors,
    retrieveMemoriesWithEnergyThresholding,
    sectoralInterdependenceMatrixForCognitiveResonance,
    tauEnergyThresholdForRetrieval,
    thetaConsolidationCoefficientForLongTerm,
} from "../../ops/dynamics";
import { AppError } from "../errors";

const SalienceSchema = z.object({
    initialSalience: z.number().optional().default(0.5),
    decayLambda: z.number().optional().default(0.01),
    recallCount: z.number().optional().default(0),
    emotionalFrequency: z.number().optional().default(0),
    timeElapsedDays: z.number().optional().default(0),
});

const ResonanceSchema = z.object({
    memorySector: z.string().optional().default("semantic"),
    querySector: z.string().optional().default("semantic"),
    baseSimilarity: z.number().optional().default(0.8),
});

const EnergyRetrievalSchema = z.object({
    query: z.string().min(1),
    sector: z.string().optional().default("semantic"),
    minEnergy: z.number().optional().default(tauEnergyThresholdForRetrieval),
    userId: z.string().optional(),
});

const SpreadingActivationSchema = z.object({
    initialMemoryIds: z.array(z.string()).min(1).max(50),
    maxIterations: z.number().min(1).max(10).optional().default(3),
    userId: z.string().optional(),
});

const TraceReinforceSchema = z.object({
    memoryId: z.string().min(1),
    userId: z.string().optional(),
});

const WaypointWeightSchema = z.object({
    sourceMemoryId: z.string().min(1),
    targetMemoryId: z.string().min(1),
    userId: z.string().optional(),
});

const WaypointGraphSchema = z.object({
    limit: z.preprocess((val) => {
        if (typeof val === 'string') return parseInt(val, 10);
        return val;
    }, z.number().optional().default(1000)),
    userId: z.string().optional(),
});

const GraphQuerySchema = z.object({
    limit: z
        .string()
        .optional()
        .transform((val) => parseInt(val || "1000"))
        .pipe(z.number().min(1).max(10000)),
});

interface DynamicsGraphEdge {
    targetNodeId: string;
    linkWeightValue: number;
    timeGapDeltaT: number;
}

interface DynamicsNodeData {
    nodeMemoryId: string;
    activationEnergyLevel: number;
    connectedWaypointEdges: DynamicsGraphEdge[];
}

interface WaypointNode {
    memoryId: string;
    edgeCount: number;
    connections: {
        targetId: string;
        weight: number;
        timeGapMs: number;
    }[];
}

export const dynamicsRoutes = (app: Elysia) => app.group("/dynamics", (app) => {
    return app
        /**
         * GET /dynamics/constants
         * Returns the internal dynamics coefficients and matrices.
         */
        .get("/constants", () => {
            const constants = {
                alphaLearningRate: alphaLearningRateForRecallReinforcement,
                betaLearningRate: betaLearningRateForEmotionalFrequency,
                gammaAttenuationConstant:
                    gammaAttenuationConstantForGraphDistance,
                thetaConsolidationCoefficient:
                    thetaConsolidationCoefficientForLongTerm,
                etaReinforcementFactor:
                    etaReinforcementFactorForTraceLearning,
                lambdaOneFastDecay: lambdaOneFastDecayRate,
                lambdaTwoSlowDecay: lambdaTwoSlowDecayRate,
                tauEnergyThreshold: tauEnergyThresholdForRetrieval,
                sectoralInterdependenceMatrix:
                    sectoralInterdependenceMatrixForCognitiveResonance,
            };
            return {
                success: true,
                constants,
            };
        })

        /**
         * POST /dynamics/salience/calculate
         * Calculates modulated salience for a hypothetical memory state.
         */
        .post("/salience/calculate", async ({ body }) => {
            const params = SalienceSchema.parse(body);

            const result = await calculateDynamicSalienceWithTimeDecay(
                params.initialSalience,
                params.decayLambda,
                params.recallCount,
                params.emotionalFrequency,
                params.timeElapsedDays,
            );

            return {
                success: true,
                calculatedSalience: result,
                parameters: params,
            };
        })

        /**
         * POST /dynamics/resonance/calculate
         * Calculates cross-sector cognitive resonance scores.
         */
        .post("/resonance/calculate", async ({ body }) => {
            const params = ResonanceSchema.parse(body);

            // Assuming calculateCrossSectorResonanceScore is a typo and should be calculateCrossSectorResonance
            const result = await calculateCrossSectorResonance(
                params.memorySector,
                params.querySector,
                params.baseSimilarity,
            );

            return {
                success: true,
                resonanceModulatedScore: result,
                parameters: params,
            };
        })

        /**
         * POST /dynamics/retrieval/energy-based
         * Performs retrieval using neural activation energy thresholds.
         */
        .post("/retrieval/energy-based", async ({ body, ...ctx }) => {
            const params = EnergyRetrievalSchema.parse(body);
            const user = getUser(ctx);
            const targetUserId = normalizeUserId(params.userId || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User required");
            verifyUserAccess(user, targetUserId);

            const { embedForSector } = await import("../../memory/embed");
            const queryVector = await embedForSector(params.query, params.sector);

            const results = await retrieveMemoriesWithEnergyThresholding(
                queryVector,
                params.sector,
                params.minEnergy,
                targetUserId,
            );

            return {
                success: true,
                query: params.query,
                sector: params.sector,
                minEnergy: params.minEnergy,
                count: results.length,
                memories: results.map((m) => {
                    const memWithEnergy = m as typeof m & {
                        activationEnergy: number;
                    };
                    return {
                        id: m.id,
                        content: m.content,
                        primarySector: m.primarySector,
                        salience: m.salience,
                        activationEnergy: memWithEnergy.activationEnergy,
                    };
                }),
            };
        })

        /**
         * POST /dynamics/reinforcement/trace
         * Manually triggers a trace reinforcement event for a memory.
         */
        .post("/reinforcement/trace", async ({ body, ...ctx }) => {
            const params = TraceReinforceSchema.parse(body);
            const memoryId = params.memoryId;
            const user = getUser(ctx);
            const targetUserId = normalizeUserId(params.userId || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User required");
            verifyUserAccess(user, targetUserId);

            const memory = await q.getMem.get(memoryId, targetUserId);

            if (!memory) {
                throw new AppError(404, "NOT_FOUND", "Memory not found");
            }

            const salience = memory.salience || 0.1;
            const waypoints = await q.getWaypointsBySrc.all(
                memoryId,
                user?.id,
            );

            // Replaced propagateAssociativeReinforcementToLinkedNodes with propagateReinforcementToNeighbors
            const propagatedUpdates =
                await propagateReinforcementToNeighbors(
                    memoryId,
                    salience,
                    waypoints.map((w: { dstId: string; weight: number }) => ({
                        targetId: w.dstId,
                        weight: w.weight,
                    })),
                    user?.id,
                );

            const nowTimestamp = Date.now();
            for (const update of propagatedUpdates) {
                await q.updSeen.run(
                    update.nodeId,
                    nowTimestamp,
                    update.newSalience,
                    nowTimestamp,
                    user?.id,
                );
            }

            const boostedSalience = Math.min(1, salience + 0.15);
            await q.updSeen.run(
                memoryId,
                nowTimestamp,
                boostedSalience,
                nowTimestamp,
                user?.id,
            );

            return {
                success: true,
                propagatedCount: propagatedUpdates.length,
                newSalience: boostedSalience,
            };
        })

        /**
         * POST /dynamics/activation/spreading
         * Simulates spreading activation across the associative graph.
         */
        .post("/activation/spreading", async ({ body, ...ctx }) => {
            const params = SpreadingActivationSchema.parse(body);
            const user = getUser(ctx);
            const targetUserId = normalizeUserId(params.userId || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User required");
            verifyUserAccess(user, targetUserId);

            const resultsMap = await performSpreadingActivationRetrieval(
                params.initialMemoryIds,
                params.maxIterations,
                targetUserId,
            );

            const activationResults = Array.from(resultsMap.entries())
                .map(([memoryId, activationLevel]) => ({
                    memoryId,
                    activationLevel,
                }))
                .sort((a, b) => b.activationLevel - a.activationLevel);

            return {
                success: true,
                initialCount: params.initialMemoryIds.length,
                iterations: params.maxIterations,
                totalActivated: activationResults.length,
                results: activationResults,
            };
        })

        /**
         * GET /dynamics/waypoints/graph
         * Exports the structural representation of the associative waypoint graph.
         */
        .get("/waypoints/graph", async ({ query, ...ctx }) => {
            const params = WaypointGraphSchema.parse(query);
            const user = getUser(ctx);
            const targetUserId = normalizeUserId(params.userId || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User required");
            verifyUserAccess(user, targetUserId);

            const waypointGraph =
                await buildAssociativeWaypointGraphFromMemories(
                    targetUserId,
                    params.limit,
                );

            const stats = {
                totalNodes: waypointGraph.size,
                totalEdges: 0,
                averageEdgesPerNode: 0,
                disconnectedNodes: 0,
            };

            const nodes: WaypointNode[] = [];
            // Cast the generic map to our specific structure
            const graph = waypointGraph as unknown as Map<
                string,
                DynamicsNodeData
            >;

            for (const [memoryId, nodeData] of graph) {
                const edgeCount = nodeData.connectedWaypointEdges.length;
                stats.totalEdges += edgeCount;

                if (edgeCount === 0) {
                    stats.disconnectedNodes++;
                }

                nodes.push({
                    memoryId: memoryId,
                    edgeCount: edgeCount,
                    connections: nodeData.connectedWaypointEdges.map(
                        (edge) => ({
                            targetId: edge.targetNodeId,
                            weight: edge.linkWeightValue,
                            timeGapMs: edge.timeGapDeltaT,
                        }),
                    ),
                });
            }

            if (stats.totalNodes > 0) {
                stats.averageEdgesPerNode =
                    stats.totalEdges / stats.totalNodes;
            }

            return {
                success: true,
                stats,
                nodes,
            };
        })

        /**
         * POST /dynamics/waypoints/calculate-weight
         * Calculates the projected associative weight between two memories.
         */
        .post("/waypoints/calculate-weight", async ({ body, ...ctx }) => {
            const params = WaypointWeightSchema.parse(body);
            const user = getUser(ctx);
            const targetUserId = normalizeUserId(params.userId || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User required");
            verifyUserAccess(user, targetUserId);

            const { sourceMemoryId, targetMemoryId } = params;
            const sourceMemory = await q.getMem.get(sourceMemoryId, targetUserId);
            const targetMemory = await q.getMem.get(targetMemoryId, targetUserId);

            if (!sourceMemory || !targetMemory) {
                throw new AppError(404, "NOT_FOUND", "One or both memories not found");
            }

            if (!sourceMemory.meanVec || !targetMemory.meanVec) {
                throw new AppError(400, "MISSING_EMBEDDINGS", "Memories missing embeddings");
            }

            const { bufferToVector } = await import("../../memory/embed");
            const sourceVector = bufferToVector(sourceMemory.meanVec);
            const targetVector = bufferToVector(targetMemory.meanVec);

            const timeGapMs = Math.abs(
                (sourceMemory.createdAt || 0) -
                (targetMemory.createdAt || 0),
            );

            const weight = await calculateAssociativeWaypointLinkWeight(
                sourceVector,
                targetVector,
                timeGapMs,
            );

            return {
                success: true,
                sourceId: sourceMemoryId,
                targetId: targetMemoryId,
                weight,
                timeGapDays: timeGapMs / 86400000,
                details: {
                    temporalDecay: true,
                    cosineSimilarity: true,
                },
            };
        });
});
