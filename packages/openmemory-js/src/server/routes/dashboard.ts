import { q, all_async, run_async } from "../../core/db";
import { env } from "../../core/cfg";
import * as fs from "fs";
import * as path from "path";
import { AdvancedRequest, AdvancedResponse } from "../index";
import { sendError, AppError } from "../errors";
import { z } from "zod";

interface DBCount { count: number; }
interface DBSize { size: number; }
interface SectorCount { primary_sector: string; count: number; }
interface AvgSalience { avg: number; }
interface DecayStats { total: number; avg_lambda: number; min_salience: number; max_salience: number; }
interface StatEntry { count: number; ts: number; }
interface StatTotal { total: number; }
interface MaintOp { type: string; hour: string; cnt: number; }
interface MaintTotal { type: string; total: number; }
interface TopMem { id: string; content: string; primary_sector: string; salience: number; last_seen_at: number; }
interface TimelineEntry { primary_sector: string; label: string; sort_key: string; count: number; }
interface ActivityEntry { id: string; content: string; primary_sector: string; salience: number; created_at: number; updated_at: number; last_seen_at: number; }
interface MaintenanceStats { hour: string; decay: number; reflection: number; consolidation: number; }

const StatsQuerySchema = z.object({});
const ActivityQuerySchema = z.object({
    limit: z.string().optional().transform(val => parseInt(val || "50")).pipe(z.number().min(1).max(100))
});
const TimelineQuerySchema = z.object({
    hours: z.string().optional().transform(val => parseInt(val || "24")).pipe(z.number().min(1).max(720)) // Max 30 days
});
const TopMemoriesQuerySchema = z.object({
    limit: z.string().optional().transform(val => parseInt(val || "10")).pipe(z.number().min(1).max(50))
});
const MaintenanceQuerySchema = z.object({
    hours: z.string().optional().transform(val => parseInt(val || "24")).pipe(z.number().min(1).max(168))
});


const is_pg = env.metadata_backend === "postgres";

const get_mem_table = () => {
    if (is_pg) {
        const sc = process.env.OM_PG_SCHEMA || "public";
        const tbl = process.env.OM_PG_TABLE || "openmemory_memories";
        return `"${sc}"."${tbl}"`;
    }
    return "memories";
};

let reqz = {
    win_start: Date.now(),
    win_cnt: 0,
    qps_hist: [] as number[],
};

const log_metric = async (type: string, value: number) => {
    try {
        const sc = process.env.OM_PG_SCHEMA || "public";
        const sql = is_pg
            ? `insert into "${sc}"."stats"(type,count,ts) values($1,$2,$3)`
            : "insert into stats(type,count,ts) values(?,?,?)";
        await run_async(sql, [type, value, Date.now()]);
    } catch (e) {
        console.error("[metrics] log err:", e);
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



const get_db_sz = async (): Promise<number> => {
    try {
        if (is_pg) {
            const db_name = process.env.OM_PG_DB || "openmemory";
            const result = await all_async<DBSize>(
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
        console.error("[db_sz] err:", e);
        return 0;
    }
};

export function req_tracker_mw() {
    return (req: AdvancedRequest, res: AdvancedResponse, next: () => void) => {
        if (req.url?.startsWith("/dashboard") || req.url?.startsWith("/health")) {
            return next();
        }
        const orig = res.json.bind(res);
        res.json = (data: any) => {
            track_req(res.statusCode < 400);
            return orig(data);
        };
        next();
    };
}

export function dash(app: any) {
    /**
     * Get aggregated system stats including total memories, sector counts, and QPS.
     * @route GET /dashboard/stats
     */
    app.get("/dashboard/stats", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const user_id = req.user?.id;
            const mem_table = get_mem_table();

            // User-scoped memory stats
            const user_clause = user_id ? (is_pg ? "WHERE user_id = $1" : "WHERE user_id = ?") : (is_pg ? "WHERE user_id IS NULL" : "WHERE user_id IS NULL");
            const p = user_id ? [user_id] : [];

            const totmem = await all_async<DBCount>(
                `SELECT COUNT(*) as count FROM ${mem_table} ${user_clause}`,
                p
            );

            const sect_sql = is_pg
                ? `SELECT primary_sector, COUNT(*) as count FROM ${mem_table} ${user_clause} GROUP BY primary_sector`
                : `SELECT primary_sector, COUNT(*) as count FROM ${mem_table} ${user_clause} GROUP BY primary_sector`;

            const sectcnt = await all_async<SectorCount>(sect_sql, p);

            const dayago = Date.now() - 24 * 60 * 60 * 1000;
            const rec_clause = is_pg
                ? (user_id ? "WHERE created_at > $1 AND user_id = $2" : "WHERE created_at > $1 AND user_id IS NULL")
                : (user_id ? "WHERE created_at > ? AND user_id = ?" : "WHERE created_at > ? AND user_id IS NULL");
            const rec_p = is_pg
                ? (user_id ? [dayago, user_id] : [dayago])
                : (user_id ? [dayago, user_id] : [dayago]);

            const recmem = await all_async<DBCount>(
                `SELECT COUNT(*) as count FROM ${mem_table} ${rec_clause}`,
                rec_p,
            );

            const avgsal = await all_async<AvgSalience>(
                `SELECT AVG(salience) as avg FROM ${mem_table} ${user_clause}`,
                p
            );

            const decst = await all_async<DecayStats>(`
                SELECT
                    COUNT(*) as total,
                    AVG(decay_lambda) as avg_lambda,
                    MIN(salience) as min_salience,
                    MAX(salience) as max_salience
                FROM ${mem_table} ${user_clause}
            `, p);
            const upt = process.uptime();

            // Calculate QPS stats from database (last hour)
            const hour_ago = Date.now() - 60 * 60 * 1000;
            const sc = process.env.OM_PG_SCHEMA || "public";
            const qps_data = await all_async<StatEntry>(
                is_pg
                    ? `SELECT count, ts FROM "${sc}"."stats" WHERE type=$1 AND ts > $2 ORDER BY ts DESC`
                    : "SELECT count, ts FROM stats WHERE type=? AND ts > ? ORDER BY ts DESC",
                ["qps", hour_ago],
            );
            const err_data = await all_async<StatTotal>(
                is_pg
                    ? `SELECT COUNT(*) as total FROM "${sc}"."stats" WHERE type=$1 AND ts > $2`
                    : "SELECT COUNT(*) as total FROM stats WHERE type=? AND ts > ?",
                ["error", hour_ago],
            );

            const peak_qps =
                qps_data.length > 0
                    ? Math.max(...qps_data.map((d) => d.count))
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
                (sum, d) => sum + d.count,
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

            res.json({
                totalMemories: totmem[0]?.count || 0,
                recentMemories: recmem[0]?.count || 0,
                sectorCounts: sectcnt.reduce((acc, row) => {
                    acc[row.primary_sector] = row.count;
                    return acc;
                }, {} as Record<string, number>),
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
                    embedProvider: env.emb_kind,
                },
            });
        } catch (e: any) {
            sendError(res, e);
        }
    });

    app.get("/dashboard/health", async (_req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const memusg = process.memoryUsage();
            const upt = process.uptime();
            res.json({
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
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    /**
     * Get recent activity feed (memory updates/creations).
     * @route GET /dashboard/activity
     */
    app.get("/dashboard/activity", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = ActivityQuerySchema.safeParse(req.query);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid query parameters", validated.error.format()));
            }

            const user_id = req.user?.id;
            const mem_table = get_mem_table();
            const { limit } = validated.data;

            const clause = is_pg
                ? (user_id ? "WHERE user_id = $2" : "WHERE user_id IS NULL")
                : (user_id ? "WHERE user_id = ?" : "WHERE user_id IS NULL");

            const p = is_pg
                ? (user_id ? [limit, user_id] : [limit])
                : (user_id ? [limit, user_id] : [limit]);

            const recmem = await all_async<ActivityEntry>(
                is_pg
                    ? `SELECT id, content, primary_sector, salience, created_at, updated_at, last_seen_at
                       FROM ${mem_table} ${clause} ORDER BY updated_at DESC LIMIT $1`
                    : `SELECT id, content, primary_sector, salience, created_at, updated_at, last_seen_at
                       FROM ${mem_table} ${clause} ORDER BY updated_at DESC LIMIT ?`,
                p,
            );
            res.json({
                activities: recmem.map((m) => ({
                    id: m.id,
                    type: "memory_updated",
                    sector: m.primary_sector,
                    content: m.content.substring(0, 100) + "...",
                    salience: m.salience,
                    timestamp: m.updated_at || m.created_at,
                })),
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    /**
     * Get memory creation timeline grouped by hour/day.
     * @route GET /dashboard/sectors/timeline
     */
    app.get("/dashboard/sectors/timeline", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = TimelineQuerySchema.safeParse(req.query);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid query parameters", validated.error.format()));
            }

            const mem_table = get_mem_table();
            const { hours } = validated.data;
            const strt = Date.now() - hours * 60 * 60 * 1000;

            // Use different grouping based on time range
            let displayFormat: string;
            let sortFormat: string;
            let timeKey: string;
            if (hours <= 24) {
                // For 24 hours or less, group by date+hour for sorting, display only hour
                displayFormat = is_pg
                    ? "to_char(to_timestamp(created_at/1000), 'HH24:00')"
                    : "strftime('%H:00', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                sortFormat = is_pg
                    ? "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD HH24:00')"
                    : "strftime('%Y-%m-%d %H:00', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                timeKey = "hour";
            } else if (hours <= 168) {
                // For up to 7 days, group by day
                displayFormat = is_pg
                    ? "to_char(to_timestamp(created_at/1000), 'MM-DD')"
                    : "strftime('%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                sortFormat = is_pg
                    ? "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD')"
                    : "strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                timeKey = "day";
            } else {
                // For longer periods (30 days), group by day showing month-day
                displayFormat = is_pg
                    ? "to_char(to_timestamp(created_at/1000), 'MM-DD')"
                    : "strftime('%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                sortFormat = is_pg
                    ? "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD')"
                    : "strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                timeKey = "day";
            }

            const tl = await all_async<TimelineEntry>(
                is_pg
                    ? `SELECT primary_sector, ${displayFormat} as label, ${sortFormat} as sort_key, COUNT(*) as count
                       FROM ${mem_table} WHERE created_at > $1 ${req.user?.id ? "AND user_id = $2" : "AND user_id IS NULL"} GROUP BY primary_sector, ${sortFormat} ORDER BY sort_key`
                    : `SELECT primary_sector, ${displayFormat} as label, ${sortFormat} as sort_key, COUNT(*) as count
                       FROM ${mem_table} WHERE created_at > ? ${req.user?.id ? "AND user_id = ?" : "AND user_id IS NULL"} GROUP BY primary_sector, ${sortFormat} ORDER BY sort_key`,
                req.user?.id ? [strt, req.user.id] : [strt],
            );
            res.json({
                timeline: tl.map((row) => ({ ...row, hour: row.label })),
                grouping: timeKey,
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    /**
     * Get memories with highest salience scores.
     * @route GET /dashboard/top-memories
     */
    app.get("/dashboard/top-memories", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = TopMemoriesQuerySchema.safeParse(req.query);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid query parameters", validated.error.format()));
            }

            const user_id = req.user?.id;
            const mem_table = get_mem_table();
            const { limit } = validated.data;

            const clause = is_pg
                ? (user_id ? "WHERE user_id = $2" : "WHERE user_id IS NULL")
                : (user_id ? "WHERE user_id = ?" : "WHERE user_id IS NULL");
            const p = is_pg
                ? (user_id ? [limit, user_id] : [limit])
                : (user_id ? [limit, user_id] : [limit]);

            const topm = await all_async<TopMem>(
                is_pg
                    ? `SELECT id, content, primary_sector, salience, last_seen_at
                       FROM ${mem_table} ${clause} ORDER BY salience DESC LIMIT $1`
                    : `SELECT id, content, primary_sector, salience, last_seen_at
                       FROM ${mem_table} ${clause} ORDER BY salience DESC LIMIT ?`,
                p,
            );
            res.json({
                memories: topm.map((m) => ({
                    id: m.id,
                    content: m.content,
                    sector: m.primary_sector,
                    salience: m.salience,
                    lastSeen: m.last_seen_at,
                })),
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    /**
     * Get maintenance operation stats (decay, reflection, consolidation).
     * @route GET /dashboard/maintenance
     */
    app.get("/dashboard/maintenance", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = MaintenanceQuerySchema.safeParse(req.query);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid query parameters", validated.error.format()));
            }

            const { hours } = validated.data;
            const strt = Date.now() - hours * 60 * 60 * 1000;
            const sc = process.env.OM_PG_SCHEMA || "public";

            const ops = await all_async<MaintOp>(
                is_pg
                    ? `SELECT type, to_char(to_timestamp(ts/1000), 'HH24:00') as hour, SUM(count) as cnt
                       FROM "${sc}"."stats" WHERE ts > $1 GROUP BY type, hour ORDER BY hour`
                    : `SELECT type, strftime('%H:00', datetime(ts/1000, 'unixepoch', 'localtime')) as hour, SUM(count) as cnt
                       FROM stats WHERE ts > ? GROUP BY type, hour ORDER BY hour`,
                [strt],
            );

            const totals = await all_async<MaintTotal>(
                is_pg
                    ? `SELECT type, SUM(count) as total FROM "${sc}"."stats" WHERE ts > $1 GROUP BY type`
                    : `SELECT type, SUM(count) as total FROM stats WHERE ts > ? GROUP BY type`,
                [strt],
            );

            const by_hr: Record<string, MaintenanceStats> = {};
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
                totals.find((t) => t.type === "decay")?.total || 0;
            const tot_reflect =
                totals.find((t) => t.type === "reflect")?.total || 0;
            const tot_consol =
                totals.find((t) => t.type === "consolidate")?.total || 0;
            const tot_ops = tot_decay + tot_reflect + tot_consol;
            const efficiency =
                tot_ops > 0
                    ? Math.round(((tot_reflect + tot_consol) / tot_ops) * 100)
                    : 0;

            res.json({
                operations: Object.values(by_hr),
                totals: {
                    cycles: tot_decay,
                    reflections: tot_reflect,
                    consolidations: tot_consol,
                    efficiency,
                },
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });
}
