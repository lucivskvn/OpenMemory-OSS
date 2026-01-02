import { q } from "../../core/db";
import type { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import {
    calculateDynamicSalienceWithTimeDecay,
    calculateCrossSectorResonanceScore,
    retrieveMemoriesWithEnergyThresholding,
    propagateAssociativeReinforcementToLinkedNodes,
    performSpreadingActivationRetrieval,
    buildAssociativeWaypointGraphFromMemories,
    calculateAssociativeWaypointLinkWeight,
    ALPHA_LEARNING_RATE_FOR_RECALL_REINFORCEMENT,
    BETA_LEARNING_RATE_FOR_EMOTIONAL_FREQUENCY,
    GAMMA_ATTENUATION_CONSTANT_FOR_GRAPH_DISTANCE,
    THETA_CONSOLIDATION_COEFFICIENT_FOR_LONG_TERM,
    ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING,
    LAMBDA_ONE_FAST_DECAY_RATE,
    LAMBDA_TWO_SLOW_DECAY_RATE,
    TAU_ENERGY_THRESHOLD_FOR_RETRIEVAL,
    SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE,
} from "../../ops/dynamics";
import { z } from "zod";

const SalienceSchema = z.object({
    initial_salience: z.number().optional().default(0.5),
    decay_lambda: z.number().optional().default(0.01),
    recall_count: z.number().optional().default(0),
    emotional_frequency: z.number().optional().default(0),
    time_elapsed_days: z.number().optional().default(0)
});

const ResonanceSchema = z.object({
    memory_sector: z.string().optional().default("semantic"),
    query_sector: z.string().optional().default("semantic"),
    base_similarity: z.number().optional().default(0.8)
});

const EnergyRetrievalSchema = z.object({
    query: z.string().min(1),
    sector: z.string().optional().default("semantic"),
    min_energy: z.number().optional().default(TAU_ENERGY_THRESHOLD_FOR_RETRIEVAL)
});

const SpreadingActivationSchema = z.object({
    initial_memory_ids: z.array(z.string()).min(1),
    max_iterations: z.number().optional().default(3)
});

export function dynroutes(app: any) {
    app.get("/dynamics/constants", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const constants = {
                alpha_learning_rate: ALPHA_LEARNING_RATE_FOR_RECALL_REINFORCEMENT,
                beta_learning_rate: BETA_LEARNING_RATE_FOR_EMOTIONAL_FREQUENCY,
                gamma_attenuation_constant: GAMMA_ATTENUATION_CONSTANT_FOR_GRAPH_DISTANCE,
                theta_consolidation_coefficient: THETA_CONSOLIDATION_COEFFICIENT_FOR_LONG_TERM,
                eta_reinforcement_factor: ETA_REINFORCEMENT_FACTOR_FOR_TRACE_LEARNING,
                lambda_one_fast_decay: LAMBDA_ONE_FAST_DECAY_RATE,
                lambda_two_slow_decay: LAMBDA_TWO_SLOW_DECAY_RATE,
                tau_energy_threshold: TAU_ENERGY_THRESHOLD_FOR_RETRIEVAL,
                sectoral_interdependence_matrix: SECTORAL_INTERDEPENDENCE_MATRIX_FOR_COGNITIVE_RESONANCE,
            };
            res.json({
                success: true,
                constants,
            });
        } catch (err) {
            console.error("[DYNAMICS] Error retrieving dynamics constants:", err);
            sendError(res, err);
        }
    });

    app.post("/dynamics/salience/calculate", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = SalienceSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid salience parameters", validated.error.format()));
            }

            const { initial_salience, decay_lambda, recall_count, emotional_frequency, time_elapsed_days } = validated.data;

            const result = await calculateDynamicSalienceWithTimeDecay(
                initial_salience,
                decay_lambda,
                recall_count,
                emotional_frequency,
                time_elapsed_days,
            );

            res.json({
                success: true,
                calculated_salience: result,
                parameters: validated.data,
            });
        } catch (err) {
            console.error("[DYNAMICS] Error calculating dynamic salience:", err);
            sendError(res, err);
        }
    });

    app.post("/dynamics/resonance/calculate", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = ResonanceSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid resonance parameters", validated.error.format()));
            }

            const { memory_sector, query_sector, base_similarity } = validated.data;

            const result = await calculateCrossSectorResonanceScore(
                memory_sector,
                query_sector,
                base_similarity,
            );

            res.json({
                success: true,
                resonance_modulated_score: result,
                parameters: validated.data,
            });
        } catch (err) {
            console.error("[DYNAMICS] Error calculating cross-sector resonance:", err);
            sendError(res, err);
        }
    });

    app.post("/dynamics/retrieval/energy-based", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = EnergyRetrievalSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid retrieval parameters", validated.error.format()));
            }

            const { query, sector, min_energy } = validated.data;
            const user_id = req.user?.id;

            const { embedForSector } = await import("../../memory/embed");
            const query_vector = await embedForSector(query, sector);

            const results = await retrieveMemoriesWithEnergyThresholding(
                query_vector,
                sector,
                min_energy,
                user_id,
            );

            res.json({
                success: true,
                query,
                sector,
                min_energy,
                count: results.length,
                memories: results.map((m) => ({
                    id: m.id,
                    content: m.content,
                    primary_sector: m.primary_sector,
                    salience: m.salience,
                    activation_energy: (m as any).activation_energy,
                })),
            });
        } catch (err) {
            console.error("[DYNAMICS] Error performing energy-based retrieval:", err);
            sendError(res, err);
        }
    });

    app.post("/dynamics/reinforcement/trace", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const memory_id = req.body.memory_id;
            if (!memory_id) {
                return sendError(res, new AppError(400, "MISSING_MEMORY_ID", "memory_id is required"));
            }

            const user_id = req.user?.id;
            const memory = await q.get_mem.get(memory_id, user_id);

            if (!memory) {
                return sendError(res, new AppError(404, "NOT_FOUND", "Memory not found"));
            }

            const salience = memory.salience || 0.1;
            const waypoints = await q.get_waypoints_by_src.all(memory_id, user_id);

            const propagated_updates = await propagateAssociativeReinforcementToLinkedNodes(
                memory_id,
                salience,
                waypoints.map((w) => ({ target_id: w.dst_id, weight: w.weight })),
                user_id,
            );

            const now_sec = Math.floor(Date.now() / 1000);
            for (const update of propagated_updates) {
                await q.upd_seen.run(update.node_id, now_sec, update.new_salience, now_sec);
            }

            await q.upd_seen.run(memory_id, now_sec, Math.min(1, salience + 0.15), now_sec);

            res.json({
                success: true,
                propagated_count: propagated_updates.length,
                new_salience: Math.min(1, salience + 0.15),
            });
        } catch (err) {
            console.error("[DYNAMICS] Error applying trace reinforcement:", err);
            sendError(res, err);
        }
    });

    app.post("/dynamics/activation/spreading", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = SpreadingActivationSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid spreading activation parameters", validated.error.format()));
            }

            const { initial_memory_ids, max_iterations } = validated.data;
            const user_id = req.user?.id;

            const results_map = await performSpreadingActivationRetrieval(
                initial_memory_ids,
                max_iterations,
                user_id,
            );

            const activation_results = Array.from(results_map.entries())
                .map(([memory_id, activation_level]) => ({
                    memory_id,
                    activation_level,
                }))
                .sort((a, b) => b.activation_level - a.activation_level);

            res.json({
                success: true,
                initial_count: initial_memory_ids.length,
                iterations: max_iterations,
                total_activated: activation_results.length,
                results: activation_results,
            });
        } catch (err) {
            console.error("[DYNAMICS] Error performing spreading activation:", err);
            sendError(res, err);
        }
    });

    app.get(
        "/dynamics/waypoints/graph",
        async (incoming_http_request: AdvancedRequest, outgoing_http_response: AdvancedResponse) => {
            try {
                const waypoint_graph_structure_from_database =
                    await buildAssociativeWaypointGraphFromMemories(
                        incoming_http_request.user?.id,
                    );

                const graph_statistics_summary = {
                    total_nodes_in_graph:
                        waypoint_graph_structure_from_database.size,
                    total_edges_across_all_nodes: 0,
                    average_edges_per_node: 0,
                    nodes_with_no_connections: 0,
                };

                const detailed_graph_nodes_array: any[] = [];

                for (const [
                    memory_node_identifier,
                    node_data_structure,
                ] of waypoint_graph_structure_from_database) {
                    const number_of_outgoing_edges =
                        node_data_structure.connected_waypoint_edges.length;
                    graph_statistics_summary.total_edges_across_all_nodes +=
                        number_of_outgoing_edges;

                    if (number_of_outgoing_edges === 0) {
                        graph_statistics_summary.nodes_with_no_connections++;
                    }

                    detailed_graph_nodes_array.push({
                        node_memory_id: memory_node_identifier,
                        outgoing_edges_count: number_of_outgoing_edges,
                        connected_targets:
                            node_data_structure.connected_waypoint_edges.map(
                                (edge_record) => ({
                                    target_memory_id:
                                        edge_record.target_node_id,
                                    link_weight: edge_record.link_weight_value,
                                    time_gap_milliseconds:
                                        edge_record.time_gap_delta_t,
                                }),
                            ),
                    });
                }

                if (graph_statistics_summary.total_nodes_in_graph > 0) {
                    graph_statistics_summary.average_edges_per_node =
                        graph_statistics_summary.total_edges_across_all_nodes /
                        graph_statistics_summary.total_nodes_in_graph;
                }

                outgoing_http_response.json({
                    success_status_indicator: true,
                    graph_summary_statistics: graph_statistics_summary,
                    detailed_node_information: detailed_graph_nodes_array,
                });
            } catch (unexpected_error_building_waypoint_graph) {
                console.error(
                    "[DYNAMICS] Error building waypoint graph:",
                    unexpected_error_building_waypoint_graph,
                );
                sendError(outgoing_http_response, unexpected_error_building_waypoint_graph);
            }
        },
    );

    app.post("/dynamics/waypoints/calculate-weight", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = z.object({
                source_memory_id: z.string().min(1),
                target_memory_id: z.string().min(1)
            }).safeParse(req.body);

            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Both memory IDs are required", validated.error.format()));
            }

            const { source_memory_id, target_memory_id } = validated.data;
            const user_id = req.user?.id;

            const source_memory = await q.get_mem.get(source_memory_id, user_id);
            const target_memory = await q.get_mem.get(target_memory_id, user_id);

            if (!source_memory || !target_memory) {
                return sendError(res, new AppError(404, "NOT_FOUND", "One or both memories not found"));
            }

            if (!source_memory.mean_vec || !target_memory.mean_vec) {
                return sendError(res, new AppError(400, "MISSING_EMBEDDINGS", "Memories missing embeddings"));
            }

            const { bufferToVector } = await import("../../memory/embed");
            const source_vector = bufferToVector(source_memory.mean_vec);
            const target_vector = bufferToVector(target_memory.mean_vec);

            const time_gap_ms = Math.abs((source_memory.created_at || 0) - (target_memory.created_at || 0));

            const weight = await calculateAssociativeWaypointLinkWeight(
                source_vector,
                target_vector,
                time_gap_ms,
            );

            res.json({
                success: true,
                source_id: source_memory_id,
                target_id: target_memory_id,
                weight,
                time_gap_days: time_gap_ms / 86400000,
                details: {
                    temporal_decay: true,
                    cosine_similarity: true,
                },
            });
        } catch (err) {
            console.error("[DYNAMICS] Error calculating waypoint weight:", err);
            sendError(res, err);
        }
    });
}
