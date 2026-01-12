import { z } from "zod";

import { q } from "../../core/db";
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
    propagateReinforcementToNeighbors, // Added this import
    retrieveMemoriesWithEnergyThresholding,
    sectoralInterdependenceMatrixForCognitiveResonance,
    tauEnergyThresholdForRetrieval,
    thetaConsolidationCoefficientForLongTerm,
} from "../../ops/dynamics";
import { logger } from "../../utils/logger";
import { AppError, sendError } from "../errors";
import { validateBody, validateQuery } from "../middleware/validate";

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
});

const SpreadingActivationSchema = z.object({
    initialMemoryIds: z.array(z.string()).min(1).max(50),
    maxIterations: z.number().min(1).max(10).optional().default(3),
});

const TraceReinforceSchema = z.object({
    memoryId: z.string().min(1),
});

const WaypointWeightSchema = z.object({
    sourceMemoryId: z.string().min(1),
    targetMemoryId: z.string().min(1),
});

import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

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

export function dynamicsRoutes(app: ServerApp) {
    /**
     * GET /dynamics/constants
     * Returns the internal dynamics coefficients and matrices.
     */
    app.get(
        "/dynamics/constants",
        async (_req: AdvancedRequest, res: AdvancedResponse) => {
            try {
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
                res.json({
                    success: true,
                    constants,
                });
            } catch (err) {
                logger.error(
                    "[DYNAMICS] Error retrieving dynamics constants:",
                    { error: err },
                );
                sendError(res, err);
            }
        },
    );

    /**
     * POST /dynamics/salience/calculate
     * Calculates modulated salience for a hypothetical memory state.
     * Useful for simulation or debugging decay mechanics.
     */
    app.post(
        "/dynamics/salience/calculate",
        validateBody(SalienceSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const {
                    initialSalience,
                    decayLambda,
                    recallCount,
                    emotionalFrequency,
                    timeElapsedDays,
                } = req.body as z.infer<typeof SalienceSchema>;

                const result = await calculateDynamicSalienceWithTimeDecay(
                    initialSalience,
                    decayLambda,
                    recallCount,
                    emotionalFrequency,
                    timeElapsedDays,
                );

                res.json({
                    success: true,
                    calculatedSalience: result,
                    parameters: req.body,
                });
            } catch (err) {
                logger.error("[DYNAMICS] Error calculating dynamic salience:", {
                    error: err,
                });
                sendError(res, err);
            }
        },
    );

    /**
     * POST /dynamics/resonance/calculate
     * Calculates cross-sector cognitive resonance scores.
     * Determines how much a query in one sector resonates with memories in another.
     */
    app.post(
        "/dynamics/resonance/calculate",
        validateBody(ResonanceSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { memorySector, querySector, baseSimilarity } =
                    req.body as z.infer<typeof ResonanceSchema>;

                // Assuming calculateCrossSectorResonanceScore is a typo and should be calculateCrossSectorResonance
                const result = await calculateCrossSectorResonance(
                    memorySector,
                    querySector,
                    baseSimilarity,
                );

                res.json({
                    success: true,
                    resonanceModulatedScore: result,
                    parameters: req.body,
                });
            } catch (err) {
                logger.error(
                    "[DYNAMICS] Error calculating cross-sector resonance:",
                    { error: err },
                );
                sendError(res, err);
            }
        },
    );

    /**
     * POST /dynamics/retrieval/energy-based
     * Performs retrieval using neural activation energy thresholds.
     * Only returns memories that exceed `minEnergy` activation.
     */
    app.post(
        "/dynamics/retrieval/energy-based",
        validateBody(EnergyRetrievalSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { query, sector, minEnergy } = req.body as z.infer<
                    typeof EnergyRetrievalSchema
                >;
                const userId = req.user?.id;

                const { embedForSector } = await import("../../memory/embed");
                const queryVector = await embedForSector(query, sector);

                const results = await retrieveMemoriesWithEnergyThresholding(
                    queryVector,
                    sector,
                    minEnergy,
                    userId,
                );

                res.json({
                    success: true,
                    query,
                    sector,
                    minEnergy,
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
                });
            } catch (err) {
                logger.error(
                    "[DYNAMICS] Error performing energy-based retrieval:",
                    { error: err },
                );
                sendError(res, err);
            }
        },
    );

    /**
     * POST /dynamics/reinforcement/trace
     * Manually triggers a trace reinforcement event for a memory.
     */
    app.post(
        "/dynamics/reinforcement/trace",
        validateBody(TraceReinforceSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { memoryId } = req.body as z.infer<
                    typeof TraceReinforceSchema
                >;
                const userId = req.user?.id;
                const memory = await q.getMem.get(memoryId, userId);

                if (!memory) {
                    return sendError(
                        res,
                        new AppError(404, "NOT_FOUND", "Memory not found"),
                    );
                }

                const salience = memory.salience || 0.1;
                const waypoints = await q.getWaypointsBySrc.all(
                    memoryId,
                    userId,
                );

                // Replaced propagateAssociativeReinforcementToLinkedNodes with propagateReinforcementToNeighbors
                const propagatedUpdates =
                    await propagateReinforcementToNeighbors(
                        memoryId,
                        salience,
                        waypoints.map((w) => ({
                            targetId: w.dstId,
                            weight: w.weight,
                        })),
                        userId,
                    );

                const nowTimestamp = Date.now();
                for (const update of propagatedUpdates) {
                    await q.updSeen.run(
                        update.nodeId,
                        nowTimestamp,
                        update.newSalience,
                        nowTimestamp,
                        userId,
                    );
                }

                const boostedSalience = Math.min(1, salience + 0.15);
                await q.updSeen.run(
                    memoryId,
                    nowTimestamp,
                    boostedSalience,
                    nowTimestamp,
                    userId,
                );

                res.json({
                    success: true,
                    propagatedCount: propagatedUpdates.length,
                    newSalience: boostedSalience,
                });
            } catch (err) {
                logger.error("[DYNAMICS] Error applying trace reinforcement:", {
                    error: err,
                });
                sendError(res, err);
            }
        },
    );

    /**
     * POST /dynamics/activation/spreading
     * Simulates spreading activation across the associative graph.
     */
    app.post(
        "/dynamics/activation/spreading",
        validateBody(SpreadingActivationSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { initialMemoryIds, maxIterations } = req.body as z.infer<
                    typeof SpreadingActivationSchema
                >;
                const userId = req.user?.id;

                const resultsMap = await performSpreadingActivationRetrieval(
                    initialMemoryIds,
                    maxIterations,
                    userId,
                );

                const activationResults = Array.from(resultsMap.entries())
                    .map(([memoryId, activationLevel]) => ({
                        memoryId,
                        activationLevel,
                    }))
                    .sort((a, b) => b.activationLevel - a.activationLevel);

                res.json({
                    success: true,
                    initialCount: initialMemoryIds.length,
                    iterations: maxIterations,
                    totalActivated: activationResults.length,
                    results: activationResults,
                });
            } catch (err) {
                logger.error(
                    "[DYNAMICS] Error performing spreading activation:",
                    { error: err },
                );
                sendError(res, err);
            }
        },
    );

    const GraphQuerySchema = z.object({
        limit: z
            .string()
            .optional()
            .transform((val) => parseInt(val || "1000"))
            .pipe(z.number().min(1).max(10000)),
    });

    // ... inside dynroutes ...

    /**
     * GET /dynamics/waypoints/graph
     * Exports the structural representation of the associative waypoint graph.
     */
    app.get(
        "/dynamics/waypoints/graph",
        validateQuery(GraphQuerySchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { limit } = req.query as unknown as z.infer<
                    typeof GraphQuerySchema
                >;
                const waypointGraph =
                    await buildAssociativeWaypointGraphFromMemories(
                        req.user?.id,
                        limit,
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

                res.json({
                    success: true,
                    stats,
                    nodes,
                });
            } catch (err) {
                logger.error("[DYNAMICS] Error building waypoint graph:", {
                    error: err,
                });
                sendError(res, err);
            }
        },
    );

    /**
     * POST /dynamics/waypoints/calculate-weight
     * Calculates the projected associative weight between two memories.
     */
    app.post(
        "/dynamics/waypoints/calculate-weight",
        validateBody(WaypointWeightSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { sourceMemoryId, targetMemoryId } = req.body as z.infer<
                    typeof WaypointWeightSchema
                >;
                const userId = req.user?.id;

                const sourceMemory = await q.getMem.get(sourceMemoryId, userId);
                const targetMemory = await q.getMem.get(targetMemoryId, userId);

                if (!sourceMemory || !targetMemory) {
                    return sendError(
                        res,
                        new AppError(
                            404,
                            "NOT_FOUND",
                            "One or both memories not found",
                        ),
                    );
                }

                if (!sourceMemory.meanVec || !targetMemory.meanVec) {
                    return sendError(
                        res,
                        new AppError(
                            400,
                            "MISSING_EMBEDDINGS",
                            "Memories missing embeddings",
                        ),
                    );
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

                res.json({
                    success: true,
                    sourceId: sourceMemoryId,
                    targetId: targetMemoryId,
                    weight,
                    timeGapDays: timeGapMs / 86400000,
                    details: {
                        temporalDecay: true,
                        cosineSimilarity: true,
                    },
                });
            } catch (err) {
                logger.error("[DYNAMICS] Error calculating waypoint weight:", {
                    error: err,
                });
                sendError(res, err);
            }
        },
    );
}
