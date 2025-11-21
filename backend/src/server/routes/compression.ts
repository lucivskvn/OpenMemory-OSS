import { compressionEngine, CompressionMetrics } from "../../ops/compress";

export function compression(app: any) {
    app.post("/api/compression/compress", async (req: any) => {
        try {
            const { text, algorithm } = req.body;
            if (!text)
                return new Response(
                    JSON.stringify({ error: "text required" }),
                    {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    },
                );
            let r;
            if (
                algorithm &&
                ["semantic", "syntactic", "aggressive"].includes(algorithm)
            ) {
                r = compressionEngine.compress(text, algorithm);
            } else {
                r = compressionEngine.auto(text);
            }
            return new Response(
                JSON.stringify({
                    ok: true,
                    comp: r.comp,
                    m: r.metrics,
                    hash: r.hash,
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            );
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    });

    app.post("/api/compression/batch", async (req: any) => {
        try {
            const { texts, algorithm = "semantic" } = req.body;
            if (!Array.isArray(texts))
                return new Response(
                    JSON.stringify({ error: "texts must be array" }),
                    {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    },
                );
            if (!["semantic", "syntactic", "aggressive"].includes(algorithm))
                return new Response(JSON.stringify({ error: "invalid algo" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                });
            const r = compressionEngine.batch(texts, algorithm);
            return new Response(
                JSON.stringify({
                    ok: true,
                    results: r.map((x: any) => ({
                        comp: x.comp,
                        m: x.metrics,
                        hash: x.hash,
                    })),
                    total: r.reduce((s: any, x: any) => s + x.metrics.saved, 0),
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            );
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    });

    app.post("/api/compression/analyze", async (req: any) => {
        try {
            const { text } = req.body;
            if (!text)
                return new Response(
                    JSON.stringify({ error: "text required" }),
                    {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    },
                );
            const a = compressionEngine.analyze(text);
            let best = "semantic";
            let max = 0;
            for (const [algo, m] of Object.entries(a)) {
                const met = m as CompressionMetrics;
                if (met.pct > max) {
                    max = met.pct;
                    best = algo;
                }
            }
            return new Response(
                JSON.stringify({
                    ok: true,
                    analysis: a,
                    rec: {
                        algo: best,
                        save: (a as any)[best].pct.toFixed(2) + "%",
                        lat: (a as any)[best].latency.toFixed(2) + "ms",
                    },
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            );
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    });

    app.get("/api/compression/stats", async () => {
        try {
            const s = compressionEngine.getStats();
            return new Response(
                JSON.stringify({
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
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            );
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    });

    app.post("/api/compression/reset", async () => {
        try {
            compressionEngine.reset();
            compressionEngine.clear();
            return new Response(
                JSON.stringify({ ok: true, msg: "reset done" }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            );
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    });
}
