import {
    calculateCrossSectorResonanceScore,
    propagateAssociativeReinforcementToLinkedNodes,
} from "../../ops/dynamics";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";

export const dynroutes = (app: Elysia) =>
    app.group("/dynamics", (app) =>
        app
            .post("/resonance", async ({ body, set }) => {
                const b = body;
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
            }, {
                body: t.Object({
                    source_sector: t.String(),
                    target_sector: t.String(),
                    content_similarity: t.Optional(t.Numeric())
                })
            })
            .post("/propagate", async ({ body, set }) => {
                const b = body;
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
            }, {
                body: t.Object({
                    source_id: t.String(),
                    reinforcement_value: t.Numeric(),
                    linked_nodes: t.Optional(t.Array(t.Object({
                        target_id: t.String(),
                        weight: t.Numeric()
                    })))
                })
            })
    );
