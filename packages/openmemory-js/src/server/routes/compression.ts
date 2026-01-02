import { compressionEngine, CompressionMetrics } from "../../ops/compress";
import { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import { z } from "zod";

const AlgoEnum = z.enum(["semantic", "syntactic", "aggressive"]);

const CompressSchema = z.object({
    text: z.string().min(1),
    algorithm: AlgoEnum.optional()
});

const CompressBatchSchema = z.object({
    texts: z.array(z.string()),
    algorithm: AlgoEnum.optional().default("semantic")
});

const CompressAnalyzeSchema = z.object({
    text: z.string().min(1),
    algorithm: AlgoEnum.optional()
});

export function compression(app: any) {
    app.post("/api/compression/compress", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = CompressSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid compression parameters", validated.error.format()));
            }

            const { text, algorithm } = validated.data;
            let r;
            if (algorithm) {
                r = compressionEngine.compress(text, algorithm);
            } else {
                r = compressionEngine.auto(text);
            }
            res.json({ ok: true, comp: r.comp, m: r.metrics, hash: r.hash });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    app.post("/api/compression/batch", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = CompressBatchSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid batch parameters", validated.error.format()));
            }

            const { texts, algorithm } = validated.data;
            const r = compressionEngine.batch(texts, algorithm);
            res.json({
                ok: true,
                results: r.map((x) => ({
                    comp: x.comp,
                    m: x.metrics,
                    hash: x.hash,
                })),
                total: r.reduce((s, x) => s + x.metrics.saved, 0),
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    app.post("/api/compression/analyze", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = CompressAnalyzeSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid analyze parameters", validated.error.format()));
            }

            const { text } = validated.data;
            const a = compressionEngine.analyze(text);
            let best = "semantic"; // Defaulting to string instead of union for dynamic index access
            let max = 0;

            // Type-safe iteration
            const keys = Object.keys(a) as Array<keyof typeof a>;
            for (const algo of keys) {
                const met = a[algo] as CompressionMetrics;
                if (met.pct > max) {
                    max = met.pct;
                    best = algo;
                }
            }

            const bestAlgo = best as keyof typeof a;
            res.json({
                ok: true,
                analysis: a,
                rec: {
                    algo: best,
                    save: a[bestAlgo].pct.toFixed(2) + "%",
                    lat: a[bestAlgo].latency.toFixed(2) + "ms",
                },
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    app.get("/api/compression/stats", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const s = compressionEngine.getStats();
            res.json({
                ok: true,
                stats: {
                    ...s,
                    avgRatio: (s.avgRatio * 100).toFixed(2) + "%",
                    totalPct:
                        s.originalTokens > 0
                            ? ((s.saved / s.originalTokens) * 100).toFixed(2) + "%"
                            : "0%",
                    lat: s.latency.toFixed(2) + "ms",
                    avgLat:
                        s.total > 0
                            ? (s.latency / s.total).toFixed(2) + "ms"
                            : "0ms",
                },
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    app.post("/api/compression/reset", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            compressionEngine.reset();
            compressionEngine.clear();
            res.json({ ok: true, msg: "reset done" });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });
}
