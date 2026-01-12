import { z } from "zod";

import { env } from "../../core/cfg";
import { allAsync, memoriesTable, q, runAsync, SqlValue } from "../../core/db";
import { getEncryption } from "../../core/security";
import { getSystemStats } from "../../core/stats";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import { sendError } from "../errors";
import { validateBody, validateQuery } from "../middleware/validate";

/** Parameter for maintenance stats query (hours lookback) */
interface MaintOp {
    type: string;
    hour: string;
    cnt: number;
}
interface MaintTotal {
    type: string;
    total: number;
}

/** Represents a high-salience memory for the dashboard top list */
interface TopMem {
    id: string;
    content: string;
    primarySector: string;
    salience: number;
    lastSeenAt: number;
}

/** Entry for the activity timeline visualization */
interface TimelineEntry {
    primarySector: string;
    label: string;
    sortKey: string;
    count: number;
}

/** Recent activity feed item */
interface ActivityEntry {
    id: string;
    content: string;
    primarySector: string;
    salience: number;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
}

/** Aggregated maintenance statistics for the dashboard charts */
interface MaintenanceStats {
    hour: string;
    decay: number;
    reflection: number;
    consolidation: number;
}

// --- Validation Schemas ---

const ActivityQuerySchema = z.object({
    limit: z
        .string()
        .optional()
        .transform((val) => parseInt(val || "50"))
        .pipe(z.number().min(1).max(100)),
});
const TimelineQuerySchema = z.object({
    hours: z
        .string()
        .optional()
        .transform((val) => parseInt(val || "24"))
        .pipe(z.number().min(1).max(720)), // Max 30 days
});
const TopMemoriesQuerySchema = z.object({
    limit: z
        .string()
        .optional()
        .transform((val) => parseInt(val || "10"))
        .pipe(z.number().min(1).max(50)),
});
const MaintenanceQuerySchema = z.object({
    hours: z
        .string()
        .optional()
        .transform((val) => parseInt(val || "24"))
        .pipe(z.number().min(1).max(168)),
});

const isPg = env.metadataBackend === "postgres";

const getMemTable = () => {
    if (isPg) {
        const sc = env.pgSchema || "public";
        const tbl = env.pgTable || "openmemory_memories";
        return `"${sc}"."${tbl}"`;
    }
    return memoriesTable;
};

const reqz = {
    winStart: Date.now(),
    winCnt: 0,
    qpsHist: [] as number[],
    histLimit: 60, // 60 seconds of history
};

const logMetric = async (type: string, value: number) => {
    try {
        const sc = env.pgSchema || "public";
        const sql = isPg
            ? `insert into "${sc}"."stats"(type,count,ts) values($1,$2,$3)`
            : "insert into stats(type,count,ts) values(?,?,?)";
        await runAsync(sql, [type, value, Date.now()]);
    } catch (e) {
        logger.error("[METRICS] Log failed:", { error: e });
    }
};

export function trackReq(success: boolean) {
    const now = Date.now();
    if (now - reqz.winStart >= 1000) {
        const qps = reqz.winCnt;

        reqz.qpsHist.push(qps);
        if (reqz.qpsHist.length > reqz.histLimit) reqz.qpsHist.shift();

        // Log metrics to database every second
        logMetric("qps", qps).catch((err) =>
            logger.error("[METRICS] Error logging QPS", { error: err }),
        );
        if (!success)
            logMetric("error", 1).catch((err) =>
                logger.error("[METRICS] Error logging failure", { error: err }),
            );

        reqz.winStart = now;
        reqz.winCnt = 1;
    } else {
        reqz.winCnt++;
    }
}

export function reqTrackerMw() {
    return (req: AdvancedRequest, res: AdvancedResponse, next: () => void) => {
        if (
            req.url?.startsWith("/dashboard") ||
            req.url?.startsWith("/health")
        ) {
            return next();
        }
        const orig = res.json.bind(res);
        res.json = (data: unknown) => {
            trackReq(res.statusCode < 400);
            return orig(data);
        };
        next();
    };
}

import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

export function dash(app: ServerApp) {
    /**
     * Get aggregated system stats including total memories, sector counts, and QPS.
     * @route GET /dashboard/stats
     */
    app.get(
        "/dashboard/stats",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = normalizeUserId(req.user?.id);

                if (isAdmin) {
                    const queryUser = req.query.userId as string | undefined;
                    userId = queryUser ? normalizeUserId(queryUser) : undefined;
                }

                const stats = await getSystemStats(
                    userId || undefined,
                    reqz.qpsHist,
                );

                // Add classifier info if userId is present
                if (userId) {
                    const model = await q.getClassifierModel.get(userId);
                    stats.classifier = model
                        ? {
                            version: model.version,
                            updatedAt: model.updatedAt,
                            status: "trained",
                        }
                        : { status: "untrained" };
                }

                res.json(stats);
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );



    app.get(
        "/dashboard/health",
        async (_req: AdvancedRequest, res: AdvancedResponse) => {
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
        },
    );

    /**
     * Get recent activity feed (memory updates/creations).
     * @route GET /dashboard/activity
     */
    app.get(
        "/dashboard/activity",
        validateQuery(ActivityQuerySchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = normalizeUserId(req.user?.id);

                // Admin Logic: Allow viewing specific user or global
                if (isAdmin) {
                    const queryUser = req.query.userId as string | undefined;
                    if (queryUser) {
                        userId = normalizeUserId(queryUser);
                    } else {
                        // Global View
                        userId = undefined;
                    }
                } else if (!userId) {
                    // Non-admin must have a user ID (or treated as specific 'null' user if anonymous, but strict auth implies we shouldn't be here without id unless anon admin)
                }

                const memTable = getMemTable();
                const { limit } = req.query as unknown as z.infer<
                    typeof ActivityQuerySchema
                >;

                let clause = "";
                const params: SqlValue[] = [limit];

                if (userId === undefined) {
                    clause = ""; // Global
                } else if (userId === null) {
                    clause = "WHERE user_id IS NULL";
                } else {
                    clause = isPg ? "WHERE user_id = $2" : "WHERE user_id = ?";
                    params.push(userId);
                }

                const recmem = await allAsync<ActivityEntry>(
                    `SELECT id, content, primary_sector as "primarySector", salience, created_at as "createdAt", updated_at as "updatedAt", last_seen_at as "lastSeenAt"
                 FROM ${memTable} ${clause} ORDER BY updated_at DESC LIMIT ${isPg ? "$1" : "?"}`,
                    params,
                );
                const activities = await Promise.all(
                    recmem.map(async (m) => {
                        const isNew =
                            m.createdAt >= (m.updatedAt || 0) ||
                            !m.updatedAt ||
                            Math.abs(m.createdAt - m.updatedAt) < 1000;
                        let content = m.content || "";
                        try {
                            const enc = getEncryption();
                            content = await enc.decrypt(content);
                        } catch (e) {
                            logger.warn(
                                `[DASHBOARD] Decryption failed for memory ${m.id}`,
                                { error: e },
                            );
                            content = "[Encrypted Content]";
                        }
                        const isReflective = m.primarySector === "reflective";

                        return {
                            id: m.id,
                            type: isReflective
                                ? "reflection"
                                : isNew
                                    ? "memory_created"
                                    : "memory_updated",
                            sector: m.primarySector,
                            content:
                                content.substring(0, 100) +
                                (content.length > 100 ? "..." : ""),
                            salience: m.salience,
                            timestamp: m.updatedAt || m.createdAt,
                        };
                    }),
                );
                res.json({ activities });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    /**
     * Get memory creation timeline grouped by hour/day.
     * @route GET /dashboard/sectors/timeline
     */
    app.get(
        "/dashboard/sectors/timeline",
        validateQuery(TimelineQuerySchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const memTable = getMemTable();
                const { hours } = req.query as unknown as z.infer<
                    typeof TimelineQuerySchema
                >;
                const strt = Date.now() - hours * 60 * 60 * 1000;

                // Use different grouping based on time range
                let displayFormat: string;
                let sortFormat: string;
                let timeKey: string;
                if (hours <= 24) {
                    // For 24 hours or less, group by date+hour for sorting, display only hour
                    displayFormat = isPg
                        ? "to_char(to_timestamp(created_at/1000), 'HH24:00')"
                        : "strftime('%H:00', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                    sortFormat = isPg
                        ? "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD HH24:00')"
                        : "strftime('%Y-%m-%d %H:00', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                    timeKey = "hour";
                } else if (hours <= 168) {
                    // For up to 7 days, group by day
                    displayFormat = isPg
                        ? "to_char(to_timestamp(created_at/1000), 'MM-DD')"
                        : "strftime('%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                    sortFormat = isPg
                        ? "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD')"
                        : "strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                    timeKey = "day";
                } else {
                    // For longer periods (30 days), group by day showing month-day
                    displayFormat = isPg
                        ? "to_char(to_timestamp(created_at/1000), 'MM-DD')"
                        : "strftime('%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                    sortFormat = isPg
                        ? "to_char(to_timestamp(created_at/1000), 'YYYY-MM-DD')"
                        : "strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch', 'localtime'))";
                    timeKey = "day";
                }

                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = normalizeUserId(req.user?.id);

                if (isAdmin) {
                    const queryUser = req.query.userId as string | undefined;
                    userId = queryUser ? normalizeUserId(queryUser) : undefined;
                }

                let userSubClause = "";
                const params: SqlValue[] = [strt];
                if (userId === undefined) {
                    userSubClause = "";
                } else if (userId === null) {
                    userSubClause = "AND user_id IS NULL";
                } else {
                    userSubClause = isPg
                        ? "AND user_id = $2"
                        : "AND user_id = ?";
                    params.push(userId);
                }

                const tl = await allAsync<TimelineEntry>(
                    `SELECT primary_sector as "primarySector", ${displayFormat} as label, ${sortFormat} as "sortKey", COUNT(*) as count
                 FROM ${memTable} WHERE created_at > $1 ${userSubClause} GROUP BY primary_sector, ${sortFormat} ORDER BY "sortKey"`.replace(
                        "$1",
                        isPg ? "$1" : "?",
                    ),
                    params,
                );
                res.json({
                    timeline: tl.map((row) => ({ ...row, hour: row.label })),
                    grouping: timeKey,
                });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    /**
     * Get memories with highest salience scores.
     * @route GET /dashboard/top-memories
     */
    app.get(
        "/dashboard/top-memories",
        validateQuery(TopMemoriesQuerySchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = normalizeUserId(req.user?.id);

                if (isAdmin) {
                    const queryUser = req.query.userId as string | undefined;
                    userId = queryUser ? normalizeUserId(queryUser) : undefined;
                }

                const memTable = getMemTable();
                const { limit } = req.query as unknown as z.infer<
                    typeof TopMemoriesQuerySchema
                >;

                let clause = "";
                const params: SqlValue[] = [limit];

                if (userId === undefined) {
                    clause = "";
                } else if (userId === null) {
                    clause = "WHERE user_id IS NULL";
                } else {
                    clause = isPg ? "WHERE user_id = $2" : "WHERE user_id = ?";
                    params.push(userId);
                }

                const topm = await allAsync<TopMem>(
                    `SELECT id, content, primary_sector as "primarySector", salience, last_seen_at as "lastSeenAt"
                 FROM ${memTable} ${clause} ORDER BY salience DESC LIMIT ${isPg ? "$1" : "?"}`,
                    params,
                );
                const memories = await Promise.all(
                    topm.map(async (m) => {
                        let content = m.content || "";
                        try {
                            const enc = getEncryption();
                            content = await enc.decrypt(content);
                        } catch (e) {
                            logger.warn(
                                `[DASHBOARD] Decryption failed for top memory ${m.id}`,
                                { error: e },
                            );
                            content = "[Encrypted Content]";
                        }
                        return {
                            id: m.id,
                            content: content,
                            sector: m.primarySector,
                            salience: m.salience,
                            lastSeen: m.lastSeenAt,
                        };
                    }),
                );
                res.json({ memories });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    /**
     * Get maintenance operation stats (decay, reflection, consolidation).
     * @route GET /dashboard/maintenance
     */
    app.get(
        "/dashboard/maintenance",
        validateQuery(MaintenanceQuerySchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { hours } = req.query as unknown as z.infer<
                    typeof MaintenanceQuerySchema
                >;
                const strt = Date.now() - hours * 60 * 60 * 1000;
                const sc = env.pgSchema || "public";

                const ops = await allAsync<MaintOp>(
                    isPg
                        ? `SELECT type, to_char(to_timestamp(ts/1000), 'HH24:00') as hour, SUM(count) as cnt
                       FROM "${sc}"."stats" WHERE ts > $1 GROUP BY type, hour ORDER BY hour`
                        : `SELECT type, strftime('%H:00', datetime(ts/1000, 'unixepoch', 'localtime')) as hour, SUM(count) as cnt
                       FROM stats WHERE ts > ? GROUP BY type, hour ORDER BY hour`,
                    [strt],
                );

                const totals = await allAsync<MaintTotal>(
                    isPg
                        ? `SELECT type, SUM(count) as total FROM "${sc}"."stats" WHERE ts > $1 GROUP BY type`
                        : `SELECT type, SUM(count) as total FROM stats WHERE ts > ? GROUP BY type`,
                    [strt],
                );

                const byHr: Record<string, MaintenanceStats> = {};
                for (const op of ops) {
                    if (!byHr[op.hour])
                        byHr[op.hour] = {
                            hour: op.hour,
                            decay: 0,
                            reflection: 0,
                            consolidation: 0,
                        };
                    if (op.type === "decay") byHr[op.hour].decay = op.cnt;
                    else if (op.type === "reflect")
                        byHr[op.hour].reflection = op.cnt;
                    else if (op.type === "consolidate")
                        byHr[op.hour].consolidation = op.cnt;
                }

                const totalArr = totals as MaintTotal[];
                const totDecay =
                    totalArr.find((t) => t.type === "decay")?.total || 0;
                const totReflect =
                    totalArr.find((t) => t.type === "reflect")?.total || 0;
                const totConsol =
                    totalArr.find((t) => t.type === "consolidate")?.total || 0;
                const totOps = totDecay + totReflect + totConsol;
                const efficiency =
                    totOps > 0
                        ? Math.round(((totReflect + totConsol) / totOps) * 100)
                        : 0;

                res.json({
                    operations: Object.values(byHr),
                    totals: {
                        cycles: totDecay,
                        reflections: totReflect,
                        consolidations: totConsol,
                        efficiency,
                    },
                });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    /**
     * GET /dashboard/settings
     * Retrieves persisted configuration for the authenticated user.
     */
    app.get(
        "/dashboard/settings",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const userId = normalizeUserId(req.user?.id);
                const { getPersistedConfig } =
                    await import("../../core/persisted_cfg");

                // Fetch known config types
                const openai = await getPersistedConfig(
                    userId || null,
                    "openai",
                );
                const gemini = await getPersistedConfig(
                    userId || null,
                    "gemini",
                );
                const anthropic = await getPersistedConfig(
                    userId || null,
                    "anthropic",
                );
                const ollama = await getPersistedConfig(
                    userId || null,
                    "ollama",
                );

                res.json({
                    openai: openai || {},
                    gemini: gemini || {},
                    anthropic: anthropic || {},
                    ollama: ollama || {},
                });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    /**
     * POST /dashboard/settings
     * Updates persisted configuration for the authenticated user.
     */
    app.post(
        "/dashboard/settings",
        validateBody(
            z.object({
                type: z.enum(["openai", "gemini", "anthropic", "ollama"]),
                config: z.record(z.string(), z.unknown()),
            }),
        ),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const userId = normalizeUserId(req.user?.id);
                const { type, config } = req.body as {
                    type: string;
                    config: Record<string, unknown>;
                };
                const { setPersistedConfig } =
                    await import("../../core/persisted_cfg");

                await setPersistedConfig(userId || null, type, config);

                // Log for audit
                logger.info(
                    `[CONFIG] User ${userId || "system"} updated ${type} config`,
                );

                res.json({ success: true, type });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );
}
