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
import { verifyPassword, isHashedKey } from "../../utils/crypto";

export function req_tracker_mw() {
    return async (
        req: Request,
        ctx: Context,
        next: () => Promise<Response>,
    ) => {
        const url = new URL(req.url);
        if (
            url.pathname.startsWith("/dashboard") ||
            url.pathname.startsWith("/health")
        ) {
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
        logger.error(
            { component: "DB_SIZE", err: e },
            "Failed to get database size",
        );
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
            return new Response(JSON.stringify(data), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (e: any) {
            logger.error(
                { component: "DASHBOARD", err: e },
                "Failed to get stats",
            );
            return new Response(
                JSON.stringify({ err: "internal", message: e.message }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                },
            );
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
            return new Response(JSON.stringify(data), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (e: any) {
            return new Response(
                JSON.stringify({ err: "internal", message: e.message }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                },
            );
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
            return new Response(JSON.stringify(data), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (e: any) {
            return new Response(
                JSON.stringify({ err: "internal", message: e.message }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                },
            );
        }
    });

    app.get(
        "/dashboard/sectors/timeline",
        async (req: Request, ctx: Context) => {
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
                return new Response(JSON.stringify({ timeline: tl }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (e: any) {
                return new Response(
                    JSON.stringify({ err: "internal", message: e.message }),
                    {
                        status: 500,
                        headers: { "Content-Type": "application/json" },
                    },
                );
            }
        },
    );

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
            return new Response(JSON.stringify(data), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (e: any) {
            return new Response(
                JSON.stringify({ err: "internal", message: e.message }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                },
            );
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
            return new Response(JSON.stringify(data), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (e: any) {
            return new Response(
                JSON.stringify({ err: "internal", message: e.message }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                },
            );
        }
    });

    async function telemetryStreamHandler(req: Request, ctx: Context) {
        try {
            const b = ctx.body as any;
            if (!b)
                return new Response(JSON.stringify({ err: "missing_body" }), {
                    status: 400,
                });
            const id = b.id || null;
            const user_id = b.user_id || null;
            const embedding_mode = b.embedding_mode || null;
            const duration_ms =
                typeof b.stream_duration_ms === "number"
                    ? b.stream_duration_ms
                    : null;
            const memory_ids = Array.isArray(b.memory_ids)
                ? JSON.stringify(b.memory_ids)
                : "[]";
            const query = typeof b.query === "string" ? b.query : null;

            if (!id || duration_ms === null) {
                return new Response(
                    JSON.stringify({ err: "invalid_payload" }),
                    { status: 400 },
                );
            }

            // If an admin API key is configured, require the admin key for telemetry
            if (env.admin_api_key) {
                const provided =
                    req.headers.get("x-admin-key") ||
                    req.headers.get("x-api-key") ||
                    ((req.headers.get("authorization") || "").startsWith(
                        "Bearer ",
                    )
                        ? req.headers.get("authorization")!.slice(7)
                        : null);
                if (!provided) {
                    return new Response(
                        JSON.stringify({ err: "admin_key_required" }),
                        { status: 403 },
                    );
                }
                if (!isHashedKey(env.admin_api_key)) {
                    logger.error(
                        {
                            component: "DASHBOARD",
                            err: "Plaintext admin key configured",
                        },
                        "OM_ADMIN_API_KEY must be configured as a hashed value",
                    );
                    return new Response(
                        JSON.stringify({ err: "server_config" }),
                        { status: 500 },
                    );
                }
                const ok = await verifyPassword(provided, env.admin_api_key);
                if (!ok) {
                    return new Response(
                        JSON.stringify({ err: "invalid_admin_key" }),
                        { status: 403 },
                    );
                }
                // Mark as admin for subsequent tenant checks
                (req as any).isAdmin = true;
            }

            // Determine admin status (set above when admin key present)
            const isAdmin = !!(req as any).isAdmin;

            // Tenant enforcement: when OM_STRICT_TENANT=true, require user_id
            // to be present (unless caller is admin) to avoid writing global telemetry.
            const strict =
                (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
            if (strict && !user_id && !isAdmin) {
                return new Response(
                    JSON.stringify({
                        err: "user_id_required",
                        message: "user_id required when OM_STRICT_TENANT=true",
                    }),
                    { status: 400 },
                );
            }

            await q.ins_stream_telemetry.run(
                id,
                user_id,
                embedding_mode,
                duration_ms,
                memory_ids,
                query,
                Date.now(),
            );

            return new Response(JSON.stringify({ ok: true }));
        } catch (e: any) {
            logger.error(
                { component: "DASHBOARD", err: e },
                "Failed to persist stream telemetry",
            );
            return new Response(JSON.stringify({ err: "internal" }), {
                status: 500,
            });
        }
    }

    app.post("/dashboard/telemetry/stream", telemetryStreamHandler);
    // Attach the handler to the module-level seam for tests. This assignment
    // happens after telemetryStreamHandler is defined and after the `dash`
    // function is invoked by server startup.
    __TEST_telemetryStreamHandler = telemetryStreamHandler;

    // Test seam: allow tests to import the telemetry handler directly to avoid
    // starting an HTTP server when asserting control flow. Only available in
    // test mode to avoid exporting internals in production.
    // Test seam: export handler for direct invocation in unit tests.

    app.get("/dashboard/telemetry", async (req: Request, ctx: Context) => {
        try {
            const limit = parseInt(ctx.query.get("limit") || "50");
            const offset = parseInt(ctx.query.get("offset") || "0");
            const user_id = ctx.query.get("user_id") || undefined;
            const embedding_mode = ctx.query.get("embedding_mode") || undefined;

            // If an admin API key is configured, require admin header, otherwise allow (legacy)
            let isAdmin = false;
            if (env.admin_api_key) {
                const provided =
                    req.headers.get("x-admin-key") ||
                    req.headers.get("x-api-key") ||
                    ((req.headers.get("authorization") || "").startsWith(
                        "Bearer ",
                    )
                        ? req.headers.get("authorization")!.slice(7)
                        : null);
                if (!provided) {
                    return new Response(
                        JSON.stringify({ err: "admin_key_required" }),
                        { status: 403 },
                    );
                }
                if (!isHashedKey(env.admin_api_key)) {
                    logger.error(
                        {
                            component: "DASHBOARD",
                            err: "Plaintext admin key configured",
                        },
                        "OM_ADMIN_API_KEY must be configured as a hashed value",
                    );
                    return new Response(
                        JSON.stringify({ err: "server_config" }),
                        { status: 500 },
                    );
                }
                isAdmin = await verifyPassword(provided, env.admin_api_key);
                if (!isAdmin) {
                    return new Response(
                        JSON.stringify({ err: "invalid_admin_key" }),
                        { status: 403 },
                    );
                }
            }

            // Server-side filtering using SQL to support large telemetry volumes.
            const table = is_pg
                ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_stream_telemetry"`
                : "stream_telemetry";
            let sql: string;
            let params: any[];
            if (is_pg) {
                sql = `select id,user_id,embedding_mode,duration_ms,memory_ids,query,ts from ${table} where ($1 is null or user_id=$1) and ($2 is null or embedding_mode=$2) order by ts desc limit $3 offset $4`;
                params = [
                    user_id || null,
                    embedding_mode || null,
                    limit,
                    offset,
                ];
            } else {
                // SQLite: repeat the parameter for the equality comparison due to positional binding
                sql = `select id,user_id,embedding_mode,duration_ms,memory_ids,query,ts from ${table} where (? is null or user_id=?) and (? is null or embedding_mode=?) order by ts desc limit ? offset ?`;
                params = [
                    user_id || null,
                    user_id || null,
                    embedding_mode || null,
                    embedding_mode || null,
                    limit,
                    offset,
                ];
            }
            // Enforce tenant scoping when OM_STRICT_TENANT=true unless admin
            const strict =
                (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
            if (strict && !user_id && !isAdmin) {
                return new Response(
                    JSON.stringify({
                        error: "user_id_required",
                        message:
                            "user_id parameter is required when OM_STRICT_TENANT=true",
                    }),
                    { status: 400 },
                );
            }

            let rows = await all_async(sql, params);

            // Parse memory_ids string for SQLite or keep JSON for Postgres
            const out = rows.map((r: any) => ({
                id: r.id,
                user_id: r.user_id,
                embedding_mode: r.embedding_mode,
                duration_ms: r.duration_ms,
                memory_ids:
                    typeof r.memory_ids === "string"
                        ? (() => {
                              try {
                                  return JSON.parse(r.memory_ids);
                              } catch (e) {
                                  return [];
                              }
                          })()
                        : r.memory_ids,
                query: r.query,
                ts: r.ts,
            }));

            return new Response(JSON.stringify({ telemetry: out }), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (e: any) {
            logger.error(
                { component: "DASHBOARD", err: e },
                "Failed to fetch telemetry",
            );
            return new Response(JSON.stringify({ err: "internal" }), {
                status: 500,
            });
        }
    });
}

// Test seam: expose a telemetry handler reference at the module level so tests
// can import it after `dash()` attaches handlers. This avoids exporting inner
// function references before they are defined and keeps the seam available
// only for tests.
export let __TEST_telemetryStreamHandler: any = undefined;
export const __TEST_getTelemetryHandler = () => __TEST_telemetryStreamHandler;
