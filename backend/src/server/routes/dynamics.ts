import {
    calculateCrossSectorResonanceScore,
    propagateAssociativeReinforcementToLinkedNodes,
} from "../../ops/dynamics";
import { Elysia } from "elysia";
import { log } from "../../core/log";
import { dynamics_resonance_req, dynamics_propagate_req } from "../../core/types";

export const dynroutes = (app: Elysia) =>
    app.group("/dynamics", (app) =>
        app
            .post("/resonance", async ({ body, set }) => {
                const b = body as dynamics_resonance_req;
                if (!b?.source_sector || !b?.target_sector) {
                    set.status = 400;
                    return { err: "missing_sectors" };
                }
                try {
                    const score = await calculateCrossSectorResonanceScore(
                        b.source_sector,
                        b.target_sector,
                        b.content_similarity || 0.5,
                    );
                    return { resonance_score: score };
                } catch (e: any) {
                    log.error("Dynamics resonance failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            })
            .post("/propagate", async ({ body, set }) => {
                const b = body as dynamics_propagate_req;
                if (!b?.source_id || !b?.reinforcement_value) {
                    set.status = 400;
                    return { err: "missing_params" };
                }
                try {
                    const updated =
                        await propagateAssociativeReinforcementToLinkedNodes(
                            b.source_id,
                            b.reinforcement_value,
                            b.linked_nodes || [],
                        );
                    return {
                        propagated_count: updated.length,
                        updated_nodes: updated,
                    };
                } catch (e: any) {
                    log.error("Dynamics propagate failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            })
    );
