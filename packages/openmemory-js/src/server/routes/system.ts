import { classifier } from "../../memory/classifier";
import { all_async } from "../../core/db";
import { sector_configs } from "../../memory/hsg";
import { getEmbeddingInfo } from "../../memory/embed";
import { tier, env } from "../../core/config";

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
        async (req: import("../server").AppRequest, res: import("../server").AppResponse) => {
            try {
                const payload = req.body as Record<string, unknown>;
                if (payload.event === "memory_sync" && payload.data) {
                    const data = payload.data as Record<string, any>;

                    const requiredFields = ['id', 'user_id', 'project_id', 'segment', 'content', 'simhash', 'primary_sector', 'tags', 'meta', 'created_at', 'updated_at', 'last_seen_at', 'salience', 'decay_lambda', 'version', 'mean_dim', 'mean_vec', 'compressed_vec', 'feedback_score'];
                    for (const field of requiredFields) {
                        if (!(field in data)) {
                            return res.status(400).json({ error: "Invalid sync event" });
                        }
                    }
                    const existing = await q.get_mem.get(data.id);
                    // Handle version tracker deduplication check
                    if (!existing || data.version > existing.version) {
                        // We do an upsert
                        await q.ins_mem.run(
                            data.id,
                            data.user_id,
                            data.project_id,
                            data.segment,
                            data.content,
                            data.simhash,
                            data.primary_sector,
                            data.tags,
                            data.meta,
                            data.created_at,
                            data.updated_at,
                            data.last_seen_at,
                            data.salience,
                            data.decay_lambda,
                            data.version,
                            data.mean_dim,
                            data.mean_vec,
                            data.compressed_vec,
                            data.feedback_score
                        );
                        return res.json({ ok: true, message: "Synced" });
                    }
                    return res.json({ ok: true, message: "Ignored due to version deduplication" });
                }
                res.status(400).json({ error: "Invalid sync event" });
            } catch (e: unknown) {
                console.error("[CLUSTER] Sync error:", e);
                res.status(500).json({ error: "An error occurred" });
            }
        }
    );


    const { z } = require("zod");
    const TrainSchema = z.object({
        data: z.array(z.object({
            text: z.string().min(1),
            sector: z.enum(["episodic", "semantic", "procedural", "emotional", "reflective"])
        }))
    });

    app.post(
        "/api/system/classifier/train",
        async (req: import("../server").AppRequest, res: import("../server").AppResponse) => {
            try {
                const parsed = TrainSchema.safeParse(req.body);
                if (!parsed.success) {
                    return res.status(400).json({ error: "Invalid payload format", details: parsed.error });
                }

                if (parsed.data.data.length === 0) {
                    return res.status(400).json({ error: "Data array cannot be empty" });
                }

                // Fire and forget
                classifier.train(parsed.data.data).catch(e => console.error("Classifier training error:", e));
                res.json({ ok: true, message: "Training started" });
            } catch (e: unknown) {
                res.status(500).json({ error: "An error occurred" });
            }
        }
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
            try {
                const database_sector_statistics_rows = await all_async(`
                select primary_sector as sector, count(*) as count, avg(salience) as avg_salience
                from memories
                group by primary_sector
            `);
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
