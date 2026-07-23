import { z } from "zod";
import { classifier } from "../../memory/classifier";
import { all_async } from "../../core/db";
import { sector_configs } from "../../memory/hsg";
import { getEmbeddingInfo } from "../../memory/embed";
import { tier, env } from "../../core/config";
import { require_tenant, reject_tenant_mismatch } from "../middleware/tenant";

const TIER_BENEFITS = {
    hybrid: {
        recall: 98,
        qps: "700-800",
        ram: "0.5gb/10k",
        use: "For high accuracy",
    },
    fast: {
        recall: 70,
        qps: "700-850",
        ram: "0.6GB/10k",
        use: "Local apps, extensions",
    },
    smart: {
        recall: 85,
        qps: "500-600",
        ram: "0.9GB/10k",
        use: "Production servers",
    },
    deep: {
        recall: 94,
        qps: "350-400",
        ram: "1.6GB/10k",
        use: "Cloud, high-accuracy",
    },
};

import { q } from "../../core/db";
export function sys(app: any) {
    app.post(
        "/api/cluster/sync",
        async (
            req: import("../server").AppRequest,
            res: import("../server").AppResponse,
        ) => {
            const tenant = require_tenant(req, res);
            if (!tenant) return;

            try {
                const SyncSchema = z.object({
                    event: z.literal("memory_sync"),
                    data: z.object({
                        id: z.string(),
                        user_id: z.string().nullable().optional(),
                        project_id: z.string().nullable().optional(),
                        segment: z.number().nullable().optional(),
                        content: z.string(),
                        simhash: z.string().nullable().optional(),
                        primary_sector: z.string(),
                        tags: z.any().nullable().optional(),
                        meta: z.any().nullable().optional(),
                        created_at: z.number().nullable().optional(),
                        updated_at: z.number().nullable().optional(),
                        last_seen_at: z.number().nullable().optional(),
                        salience: z.number().nullable().optional(),
                        decay_lambda: z.number().nullable().optional(),
                        version: z.number().nullable().optional(),
                        mean_dim: z.number().nullable().optional(),
                        mean_vec: z.any().nullable().optional(),
                        compressed_vec: z.any().nullable().optional(),
                        feedback_score: z.number().nullable().optional(),
                    }),
                });

                const parsed = SyncSchema.safeParse(req.body);
                if (parsed.success) {
                    const data = parsed.data.data;

                    if (reject_tenant_mismatch(res, tenant, data.user_id)) return;

                    // Ensure user_id is forced to the verified tenant if not specified
                    if (!data.user_id) {
                        data.user_id = tenant;
                    }

                    const existing = await q.get_mem.get(data.id);
                    if (existing && existing.user_id !== tenant) {
                        return res.status(403).json({
                            error: "tenant_mismatch",
                            message: "Target memory belongs to another tenant.",
                        });
                    }

                    // Handle version tracker deduplication check
                    if (!existing || (data.version ?? 1) > existing.version) {
                        // We do an upsert, coalescing undefined fields to null to avoid libSQL TypeError
                        await q.ins_mem.run(
                            data.id,
                            data.user_id ?? null,
                            data.project_id ?? null,
                            data.segment ?? null,
                            data.content,
                            data.simhash ?? null,
                            data.primary_sector,
                            data.tags ?? null,
                            data.meta ?? null,
                            data.created_at ?? null,
                            data.updated_at ?? null,
                            data.last_seen_at ?? null,
                            data.salience ?? null,
                            data.decay_lambda ?? null,
                            data.version ?? 1,
                            data.mean_dim ?? null,
                            data.mean_vec ?? null,
                            data.compressed_vec ?? null,
                            data.feedback_score ?? null,
                        );
                        return res.json({ ok: true, message: "Synced" });
                    }
                    return res.json({
                        ok: true,
                        message: "Ignored due to version deduplication",
                    });
                }
                res.status(400).json({ error: "Invalid sync event" });
            } catch (e: unknown) {
                console.error("[CLUSTER] Sync error:", e);
                res.status(500).json({ error: "An error occurred" });
            }
        },
    );

    const TrainSchema = z.object({
        data: z.array(
            z.object({
                text: z.string().min(1).max(10000),
                sector: z.enum([
                    "episodic",
                    "semantic",
                    "procedural",
                    "emotional",
                    "reflective",
                ]),
            }),
        ).max(1000),
    });

    app.post(
        "/api/system/classifier/train",
        async (
            req: import("../server").AppRequest,
            res: import("../server").AppResponse,
        ) => {
            try {
                const parsed = TrainSchema.safeParse(req.body);
                if (!parsed.success) {
                    const isProd = process.env.NODE_ENV === "production";
                    return res.status(400).json({
                        error: "Invalid payload format",
                        details: isProd ? "Validation failed" : parsed.error,
                    });
                }

                if (parsed.data.data.length === 0) {
                    return res
                        .status(400)
                        .json({ error: "Data array cannot be empty" });
                }

                // Fire and forget
                classifier
                    .train(parsed.data.data)
                    .catch((e) =>
                        console.error("Classifier training error:", e),
                    );
                res.json({ ok: true, message: "Training started" });
            } catch (e: unknown) {
                res.status(500).json({ error: "An error occurred" });
            }
        },
    );

    app.get(
        "/health",
        async (incoming_http_request: any, outgoing_http_response: any) => {
            outgoing_http_response.json({
                ok: true,
                version: "2.0-hsg-tiered",
                embedding: getEmbeddingInfo(),
                tier,
                dim: env.vec_dim,
                cache: env.cache_segments,
                expected: TIER_BENEFITS[tier],
            });
        },
    );

    app.get(
        "/sectors",
        async (incoming_http_request: any, outgoing_http_response: any) => {
            const tenant = require_tenant(incoming_http_request, outgoing_http_response);
            if (!tenant) return;
            try {
                const database_sector_statistics_rows = await all_async(`
                select primary_sector as sector, count(*) as count, avg(salience) as avg_salience
                from memories
                where user_id = ?
                group by primary_sector
            `, [tenant]);
                outgoing_http_response.json({
                    sectors: Object.keys(sector_configs),
                    configs: sector_configs,
                    stats: database_sector_statistics_rows,
                });
            } catch (unexpected_error_fetching_sectors) {
                outgoing_http_response.status(500).json({ err: "internal" });
            }
        },
    );
}
