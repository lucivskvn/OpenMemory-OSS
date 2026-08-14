import { compressionEngine, CompressionMetrics } from "../../ops/compress";
import { require_tenant } from "../middleware/tenant";
import { parse_or_400, schema } from "../middleware/validate";

const compress_schema: schema = {
    text: { type: "string", required: true, min_length: 1, max_length: 200_000 },
    algorithm: { type: "string", one_of: ["semantic", "syntactic", "aggressive"] },
};

const batch_schema: schema = {
    texts: {
        type: "array",
        required: true,
        min_items: 1,
        max_items: 100,
        items: { type: "string", min_length: 1, max_length: 200_000 },
    },
    algorithm: { type: "string", one_of: ["semantic", "syntactic", "aggressive"] },
};

const analyze_schema: schema = {
    text: { type: "string", required: true, min_length: 1, max_length: 200_000 },
};

const is_admin_tenant = (tenant: string) => {
    return (
        tenant === "admin" || tenant === "system" || tenant === "dev-no-auth"
    );
};

export function compression(app: any) {
    app.post("/api/compression/compress", async (req: any, res: any) => {
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        const b = parse_or_400<{
            text: string;
            algorithm?: "semantic" | "syntactic" | "aggressive";
        }>(res, req.body, compress_schema);
        if (!b) return;
        try {
            let r;
            if (b.algorithm) {
                r = compressionEngine.compress(b.text, b.algorithm);
            } else {
                r = compressionEngine.auto(b.text);
            }
            res.json({ ok: true, comp: r.comp, m: r.metrics, hash: r.hash });
        } catch (e: any) {
            console.error("[compression] compress error:", e);
            res.status(500).json({ error: "Compression processing failed" });
        }
    });

    app.post("/api/compression/batch", async (req: any, res: any) => {
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        const b = parse_or_400<{
            texts: string[];
            algorithm?: "semantic" | "syntactic" | "aggressive";
        }>(res, req.body, batch_schema);
        if (!b) return;
        try {
            const algo = b.algorithm || "semantic";
            const r = compressionEngine.batch(b.texts, algo);
            res.json({
                ok: true,
                results: r.map((x: any) => ({
                    comp: x.comp,
                    m: x.metrics,
                    hash: x.hash,
                })),
                total: r.reduce((s: any, x: any) => s + x.metrics.saved, 0),
            });
        } catch (e: any) {
            console.error("[compression] batch error:", e);
            res.status(500).json({ error: "Compression processing failed" });
        }
    });

    app.post("/api/compression/analyze", async (req: any, res: any) => {
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        const b = parse_or_400<{ text: string }>(res, req.body, analyze_schema);
        if (!b) return;
        try {
            const a = compressionEngine.analyze(b.text);
            let best = "semantic";
            let max = 0;
            for (const [algo, m] of Object.entries(a)) {
                const met = m as CompressionMetrics;
                if (met.pct > max) {
                    max = met.pct;
                    best = algo;
                }
            }
            res.json({
                ok: true,
                analysis: a,
                rec: {
                    algo: best,
                    save: (a as any)[best].pct.toFixed(2) + "%",
                    lat: (a as any)[best].latency.toFixed(2) + "ms",
                },
            });
        } catch (e: any) {
            console.error("[compression] analyze error:", e);
            res.status(500).json({ error: "Compression processing failed" });
        }
    });

    app.get("/api/compression/stats", async (req: any, res: any) => {
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        if (!is_admin_tenant(tenant)) {
            return res.status(403).json({
                error: "forbidden",
                message: "Only administrators can access compression stats",
            });
        }
        try {
            const s = compressionEngine.getStats();
            res.json({
                ok: true,
                stats: {
                    ...s,
                    avgRatio: (s.avgRatio * 100).toFixed(2) + "%",
                    totalPct:
                        s.ogTok > 0
                            ? ((s.saved / s.ogTok) * 100).toFixed(2) + "%"
                            : "0%",
                    lat: s.latency.toFixed(2) + "ms",
                    avgLat:
                        s.total > 0
                            ? (s.latency / s.total).toFixed(2) + "ms"
                            : "0ms",
                },
            });
        } catch (e: any) {
            console.error("[compression] stats error:", e);
            res.status(500).json({ error: "Compression processing failed" });
        }
    });

    app.post("/api/compression/reset", async (req: any, res: any) => {
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        if (!is_admin_tenant(tenant)) {
            return res.status(403).json({
                error: "forbidden",
                message: "Only administrators can reset compression metrics",
            });
        }
        try {
            compressionEngine.reset();
            compressionEngine.clear();
            res.json({ ok: true, msg: "reset done" });
        } catch (e: any) {
            console.error("[compression] reset error:", e);
            res.status(500).json({ error: "Compression processing failed" });
        }
    });
}
