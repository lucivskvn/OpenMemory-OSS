import { q, all_async, run_async } from "../../core/db";
import { env } from "../../core/cfg";
import * as fs from "fs";
import * as path from "path";
import logger from "../../core/logger";

const is_pg = env.metadata_backend === "postgres";

let reqz = {
    win_start: Date.now(),
    win_cnt: 0,
    qps_hist: [] as number[],
};

const log_metric = async (type: string, value: number) => {
    try {
        await run_async("insert into stats(type,count,ts) values(?,?,?)", [
            type,
            value,
            Date.now(),
        ]);
    } catch (e) {
        logger.error({ component: "METRICS", err: e }, "Failed to log metric");
    }
};

export function track_req(success: boolean) {
    const now = Date.now();
    if (now - reqz.win_start >= 1000) {
        const qps = reqz.win_cnt;

        reqz.qps_hist.push(qps);
        if (reqz.qps_hist.length > 5) reqz.qps_hist.shift();

        // Log metrics to database every second
        log_metric("qps", qps).catch(console.error);
        if (!success) log_metric("error", 1).catch(console.error);

        reqz.win_start = now;
        reqz.win_cnt = 1;
    } else {
        reqz.win_cnt++;
    }
}

import { Context } from "../server";

export function req_tracker_mw() {
    return async (req: Request, ctx: Context, next: () => Promise<Response>) => {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/dashboard") || url.pathname.startsWith("/health")) {
            return next();
        }

        const response = await next();
        track_req(response.status < 400);
        return response;
    };
}

const get_db_sz = async (): Promise<number> => {
    try {
        if (is_pg) {
            const db_name = process.env.OM_PG_DB || "openmemory";
            const result = await all_async(
                `SELECT pg_database_size('${db_name}') as size`,
            );
            return result[0]?.size
                ? Math.round(result[0].size / 1024 / 1024)
                : 0;
        } else {
            const dbp = path.resolve(process.cwd(), "./backend", env.db_path);

            if (fs.existsSync(dbp)) {
                const st = fs.statSync(dbp);
                return Math.round(st.size / 1024 / 1024);
            }
            return 0;
        }
    } catch (e) {
        logger.error({ component: "DB_SIZE", err: e }, "Failed to get database size");
        return 0;
    }
};

export function dash(app: any) {
    app.get("/dashboard/stats", async (req: Request, ctx: Context) => {
        try {
            const totmem = await all_async(
                "SELECT COUNT(*) as count FROM memories",
            );
            const sectcnt = await all_async(`
                SELECT primary_sector, COUNT(*) as count 
                FROM memories 
                GROUP BY primary_sector
            `);
            const dayago = Date.now() - 24 * 60 * 60 * 1000;
            const recmem = await all_async(
                "SELECT COUNT(*) as count FROM memories WHERE created_at > ?",
                [dayago],
            );
            const avgsal = await all_async(
                "SELECT AVG(salience) as avg FROM memories",
            );
            const decst = await all_async(`
                SELECT 
                    COUNT(*) as total,
                    AVG(decay_lambda) as avg_lambda,
                    MIN(salience) as min_salience,
                    MAX(salience) as max_salience
                FROM memories
            `);
            const upt = process.uptime();

            const hour_ago = Date.now() - 60 * 60 * 1000;
            const qps_data = await all_async(
                "SELECT count, ts FROM stats WHERE type=? AND ts > ? ORDER BY ts DESC",
                ["qps", hour_ago],
            );
            const err_data = await all_async(
                "SELECT COUNT(*) as total FROM stats WHERE type=? AND ts > ?",
                ["error", hour_ago],
            );

            const peak_qps =
                qps_data.length > 0
                    ? Math.max(...qps_data.map((d: any) => d.count))
                    : 0;
            const avg_qps =
                reqz.qps_hist.length > 0
                    ? Math.round(
                          (reqz.qps_hist.reduce((a, b) => a + b, 0) /
                              reqz.qps_hist.length) *
                              100,
                      ) / 100
                    : 0;
            const total_reqs = qps_data.reduce(
                (sum: number, d: any) => sum + d.count,
                0,
            );
            const total_errs = err_data[0]?.total || 0;
            const err_rate =
                total_reqs > 0
                    ? ((total_errs / total_reqs) * 100).toFixed(1)
                    : "0.0";

            const dbsz = await get_db_sz();
            const dbpct =
                dbsz > 0 ? Math.min(100, Math.round((dbsz / 1024) * 100)) : 0;
            const cachit =
                totmem[0]?.count > 0
                    ? Math.round(
                          (totmem[0].count /
                              (totmem[0].count + total_errs * 2)) *
                              100,
                      )
                    : 0;

            const data = {
                totalMemories: totmem[0]?.count || 0,
                recentMemories: recmem[0]?.count || 0,
                sectorCounts: sectcnt.reduce((acc: any, row: any) => {
                    acc[row.primary_sector] = row.count;
                    return acc;
                }, {}),
                avgSalience: Number(avgsal[0]?.avg || 0).toFixed(3),
                decayStats: {
                    total: decst[0]?.total || 0,
                    avgLambda: Number(decst[0]?.avg_lambda || 0).toFixed(3),
                    minSalience: Number(decst[0]?.min_salience || 0).toFixed(3),
                    maxSalience: Number(decst[0]?.max_salience || 0).toFixed(3),
                },
                requests: {
                    total: total_reqs,
                    errors: total_errs,
                    errorRate: err_rate,
                    lastHour: qps_data.length,
                },
                qps: { peak: peak_qps, average: avg_qps, cacheHitRate: cachit },
                system: {
                    memoryUsage: dbpct,
                    heapUsed: dbsz,
                    heapTotal: 1024,
                    uptime: {
                        seconds: Math.floor(upt),
                        days: Math.floor(upt / 86400),
                        hours: Math.floor((upt % 86400) / 3600),
                    },
                },
                config: {
                    port: env.port,
                    vecDim: env.vec_dim,
                    cacheSegments: env.cache_segments,
                    maxActive: env.max_active,
                    decayInterval: env.decay_interval_minutes,
                    embedProvider: env.embed_kind,
                },
            };
            return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
            logger.error({ component: "DASHBOARD", err: e }, "Failed to get stats");
            return new Response(JSON.stringify({ err: "internal", message: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.get("/dashboard/health", async (req: Request, ctx: Context) => {
        try {
            const memusg = process.memoryUsage();
            const upt = process.uptime();
            const data = {
                memory: {
                    heapUsed: Math.round(memusg.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(memusg.heapTotal / 1024 / 1024),
                    rss: Math.round(memusg.rss / 1024 / 1024),
                    external: Math.round(memusg.external / 1024 / 1024),
                },
                uptime: {
                    seconds: Math.floor(upt),
                    days: Math.floor(upt / 86400),
                    hours: Math.floor((upt % 86400) / 3600),
                },
                process: {
                    pid: process.pid,
                    version: process.version,
                    platform: process.platform,
                },
            };
            return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
            return new Response(JSON.stringify({ err: "internal", message: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.get("/dashboard/activity", async (req: Request, ctx: Context) => {
        try {
            const lim = parseInt(ctx.query.get("limit") || "50");
            const recmem = await all_async(
                `
                SELECT id, content, primary_sector, salience, created_at, updated_at, last_seen_at
                FROM memories ORDER BY updated_at DESC LIMIT ?
            `,
                [lim],
            );
            const data = {
                activities: recmem.map((m: any) => ({
                    id: m.id,
                    type: "memory_updated",
                    sector: m.primary_sector,
                    content: m.content.substring(0, 100) + "...",
                    salience: m.salience,
                    timestamp: m.updated_at || m.created_at,
                })),
            };
            return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
            return new Response(JSON.stringify({ err: "internal", message: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.get("/dashboard/sectors/timeline", async (req: Request, ctx: Context) => {
        try {
            const hrs = parseInt(ctx.query.get("hours") || "24");
            const strt = Date.now() - hrs * 60 * 60 * 1000;
            const tl = await all_async(
                `
                SELECT primary_sector, strftime('%H:00', datetime(created_at/1000, 'unixepoch')) as hour, COUNT(*) as count
                FROM memories WHERE created_at > ? GROUP BY primary_sector, hour ORDER BY hour
            `,
                [strt],
            );
            return new Response(JSON.stringify({ timeline: tl }), { headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
            return new Response(JSON.stringify({ err: "internal", message: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.get("/dashboard/top-memories", async (req: Request, ctx: Context) => {
        try {
            const lim = parseInt(ctx.query.get("limit") || "10");
            const topm = await all_async(
                `
                SELECT id, content, primary_sector, salience, last_seen_at
                FROM memories ORDER BY salience DESC LIMIT ?
            `,
                [lim],
            );
            const data = {
                memories: topm.map((m: any) => ({
                    id: m.id,
                    content: m.content,
                    sector: m.primary_sector,
                    salience: m.salience,
                    lastSeen: m.last_seen_at,
                })),
            };
            return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
            return new Response(JSON.stringify({ err: "internal", message: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.get("/dashboard/maintenance", async (req: Request, ctx: Context) => {
        try {
            const hrs = parseInt(ctx.query.get("hours") || "24");
            const strt = Date.now() - hrs * 60 * 60 * 1000;

            const ops = await all_async(
                `
                SELECT 
                    type,
                    strftime('%H:00', datetime(ts/1000, 'unixepoch', 'localtime')) as hour,
                    SUM(count) as cnt
                FROM stats
                WHERE ts > ?
                GROUP BY type, hour
                ORDER BY hour
            `,
                [strt],
            );

            const totals = await all_async(
                `
                SELECT type, SUM(count) as total FROM stats WHERE ts > ? GROUP BY type
            `,
                [strt],
            );

            const by_hr: Record<string, any> = {};
            for (const op of ops) {
                if (!by_hr[op.hour])
                    by_hr[op.hour] = {
                        hour: op.hour,
                        decay: 0,
                        reflection: 0,
                        consolidation: 0,
                    };
                if (op.type === "decay") by_hr[op.hour].decay = op.cnt;
                else if (op.type === "reflect")
                    by_hr[op.hour].reflection = op.cnt;
                else if (op.type === "consolidate")
                    by_hr[op.hour].consolidation = op.cnt;
            }

            const tot_decay =
                totals.find((t: any) => t.type === "decay")?.total || 0;
            const tot_reflect =
                totals.find((t: any) => t.type === "reflect")?.total || 0;
            const tot_consol =
                totals.find((t: any) => t.type === "consolidate")?.total || 0;
            const tot_ops = tot_decay + tot_reflect + tot_consol;
            const efficiency =
                tot_ops > 0
                    ? Math.round(((tot_reflect + tot_consol) / tot_ops) * 100)
                    : 0;

            const data = {
                operations: Object.values(by_hr),
                totals: {
                    cycles: tot_decay,
                    reflections: tot_reflect,
                    consolidations: tot_consol,
                    efficiency,
                },
            };
            return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
            return new Response(JSON.stringify({ err: "internal", message: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });
}
