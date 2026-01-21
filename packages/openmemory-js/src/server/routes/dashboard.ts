import { Elysia } from "elysia";
import { z } from "zod";
import { ActivityEntry, MaintenanceStats, DashboardTimelineEntry, DashboardTopMemory, UserContext, AuthScope } from "../../core/types";

import { env } from "../../core/cfg";
import { allAsync, q, runAsync, SqlValue, TABLES } from "../../core/db";
import { getEncryption } from "../../core/security";
import { getSystemStats } from "../../core/stats";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";
import { verifyUserAccess, getUser } from "../middleware/auth";

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

// --- Validation Schemas ---

const ActivityQuerySchema = z.object({
    limit: z
        .string()
        .optional()
        .transform((val) => parseInt(val || "50"))
        .pipe(z.number().min(1).max(100)),
    userId: z.string().optional(),
});
const TimelineQuerySchema = z.object({
    hours: z
        .string()
        .optional()
        .transform((val) => parseInt(val || "24"))
        .pipe(z.number().min(1).max(720)), // Max 30 days
    userId: z.string().optional(),
});
const TopMemoriesQuerySchema = z.object({
    limit: z
        .string()
        .optional()
        .transform((val) => parseInt(val || "10"))
        .pipe(z.number().min(1).max(50)),
    userId: z.string().optional(),
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
    return TABLES.memories;
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
            logger.error("[METRICS] Error logging QPS", { error: err }));
        if (!success)
            logMetric("error", 1).catch((err) =>
                logger.error("[METRICS] Error logging failure", { error: err }));

        reqz.winStart = now;
        reqz.winCnt = 1;
    } else {
        reqz.winCnt++;
    }
}

/**
 * Dashboard Routes Plugin
 */
export const dashboardRoutes = (app: Elysia) => app
    // Metrics Tracking Hook
    .onAfterHandle(({ request, set }) => {
        if (
            request.url?.includes("/dashboard") ||
            request.url?.includes("/health")
        ) {
            return;
        }
        // Basic success tracking based on status code
        const status = typeof set.status === "number" ? set.status : 200;
        trackReq(status < 400);
    })

    /**
     * GET /dashboard/stats
     * Get aggregated system stats including total memories, sector counts, and QPS.
     */
    .get("/dashboard/stats", async ({ query, ...ctx }) => {
        const queryUser = query.userId as string | undefined;
        let targetUserId: string | undefined;

        const user = getUser(ctx);

        if (queryUser) {
            targetUserId = normalizeUserId(queryUser) as string;
        } else if (user?.id) {
            targetUserId = normalizeUserId(user.id) as string;
        } else {
            // Implicit Global View intent if no user specified
            targetUserId = undefined;
        }

        // Strictly enforce access control
        verifyUserAccess(user, targetUserId);

        const stats = await getSystemStats(
            targetUserId || undefined,
            reqz.qpsHist,
        );

        // Add classifier info if userId is present
        if (targetUserId) {
            const model = await q.getClassifierModel.get(targetUserId);
            stats.classifier = model
                ? {
                    version: model.version,
                    updatedAt: model.updatedAt,
                    status: "trained",
                }
                : { status: "untrained" };
        }

        return stats;
    })

    /**
     * GET /dashboard/health
     */
    .get("/dashboard/health", () => {
        const memusg = process.memoryUsage();
        const upt = process.uptime();
        return {
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
    })

    /**
     * GET /dashboard/activity
     * Get recent activity feed (memory updates/creations).
     */
    .get("/dashboard/activity", async ({ query, ...ctx }) => {
        // Resolve target user
        const { limit, userId: queryUser } = ActivityQuerySchema.parse(query);
        const user = getUser(ctx);

        let targetUserId: string | undefined;
        if (queryUser) {
            targetUserId = normalizeUserId(queryUser) as string;
        } else if (user?.id) {
            targetUserId = normalizeUserId(user.id) as string;
        } else {
            targetUserId = undefined; // Global
        }

        verifyUserAccess(user, targetUserId);

        const memTable = getMemTable();

        let clause = "";
        const params: SqlValue[] = [limit];

        if (targetUserId === undefined) {
            clause = ""; // Global
        } else {
            clause = isPg ? "WHERE user_id = $2" : "WHERE user_id = ?";
            params.push(targetUserId);
        }

        interface ActivityRow {
            id: string;
            content: string;
            primarySector: string;
            salience: number;
            createdAt: number;
            updatedAt: number;
            lastSeenAt: number;
        }

        const recmem = await allAsync<ActivityRow>(
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
        return { activities };
    })

    /**
     * GET /dashboard/sectors/timeline
     * Get memory creation timeline grouped by hour/day.
     */
    .get("/dashboard/sectors/timeline", async ({ query, ...ctx }) => {
        const memTable = getMemTable();
        const { hours, userId: queryUser } = TimelineQuerySchema.parse(query);
        const user = getUser(ctx);

        const strt = Date.now() - hours * 60 * 60 * 1000;

        // Resolve User
        let targetUserId: string | undefined;
        if (queryUser) {
            targetUserId = normalizeUserId(queryUser) as string;
        } else if (user?.id) {
            targetUserId = normalizeUserId(user.id) as string;
        } else {
            targetUserId = undefined;
        }

        verifyUserAccess(user, targetUserId);

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

        let userSubClause = "";
        const params: SqlValue[] = [strt];
        if (targetUserId === undefined) {
            userSubClause = "";
        } else {
            userSubClause = isPg
                ? "AND user_id = $2"
                : "AND user_id = ?";
            params.push(targetUserId);
        }

        const tl = await allAsync<DashboardTimelineEntry>(
            `SELECT primary_sector as "primarySector", ${displayFormat} as label, ${sortFormat} as "sortKey", COUNT(*) as count
             FROM ${memTable} WHERE created_at > $1 ${userSubClause} GROUP BY primary_sector, ${sortFormat} ORDER BY "sortKey"`.replace(
                "$1",
                isPg ? "$1" : "?",
            ),
            params,
        );
        return {
            timeline: tl.map((row) => ({ ...row, hour: row.label })),
            grouping: timeKey,
        };
    })

    /**
     * GET /dashboard/top-memories
     * Get memories with highest salience scores.
     */
    .get("/dashboard/top-memories", async ({ query, ...ctx }) => {
        const { limit, userId: queryUser } = TopMemoriesQuerySchema.parse(query);
        const user = getUser(ctx);

        // Resolve User
        let targetUserId: string | undefined;
        if (queryUser) {
            targetUserId = normalizeUserId(queryUser) as string;
        } else if (user?.id) {
            targetUserId = normalizeUserId(user.id) as string;
        } else {
            targetUserId = undefined;
        }

        verifyUserAccess(user, targetUserId);

        const memTable = getMemTable();

        let clause = "";
        const params: SqlValue[] = [limit];

        if (targetUserId === undefined) {
            clause = "";
        } else {
            clause = isPg ? "WHERE user_id = $2" : "WHERE user_id = ?";
            params.push(targetUserId);
        }

        const topm = await allAsync<DashboardTopMemory>(
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
        return { memories };
    })

    /**
     * GET /dashboard/maintenance
     * Get maintenance operation stats (decay, reflection, consolidation).
     */
    .get("/dashboard/maintenance", async ({ query, ...ctx }) => {
        // Maintenance stats are global system stats, but often useful for admins.
        // Standard users might not need this, but it's not sensitive user data per se.
        // However, let's restrict to Admin for now as it exposes system load.

        const user = getUser(ctx);
        // Explicitly require Admin scope
        if (!user?.scopes.includes("admin:all")) {
            throw new AppError(403, "FORBIDDEN", "Admin access required");
        }

        const { hours } = MaintenanceQuerySchema.parse(query);
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

        const byHr: Record<string, import("../../core/types").MaintenanceOpStat> = {};
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

        return {
            operations: Object.values(byHr),
            totals: {
                cycles: totDecay,
                reflections: totReflect,
                consolidations: totConsol,
                efficiency,
            },
        };
    })

    /**
     * GET /dashboard/settings
     * Retrieves persisted configuration for the authenticated user.
     */
    .get("/dashboard/settings", async (ctx) => {
        const user = getUser(ctx);
        const userId = normalizeUserId(user?.id);
        // Verify access to OWN settings (must have ID)
        if (!userId) throw new AppError(401, "UNAUTHORIZED", "User context required");
        verifyUserAccess(user, userId);

        const { getPersistedConfig } =
            await import("../../core/persisted_cfg");

        // Fetch known config types
        const openai = await getPersistedConfig(
            userId,
            "openai",
        );
        const gemini = await getPersistedConfig(
            userId,
            "gemini",
        );
        const anthropic = await getPersistedConfig(
            userId,
            "anthropic",
        );
        const ollama = await getPersistedConfig(
            userId,
            "ollama",
        );

        return {
            openai: openai || {},
            gemini: gemini || {},
            anthropic: anthropic || {},
            ollama: ollama || {},
        };
    })

    /**
     * POST /dashboard/settings
     * Updates persisted configuration for the authenticated user.
     */
    .post("/dashboard/settings", async ({ body, ...ctx }) => {
        const user = getUser(ctx);
        const userId = normalizeUserId(user?.id);
        if (!userId) throw new AppError(401, "UNAUTHORIZED", "User context required");
        verifyUserAccess(user, userId);

        const schema = z.object({
            type: z.enum(["openai", "gemini", "anthropic", "ollama"]),
            config: z.record(z.string(), z.unknown()),
        });
        const { type, config } = schema.parse(body);

        const { setPersistedConfig } =
            await import("../../core/persisted_cfg");
        const { flush_generator } =
            await import("../../ai/adapters");

        await setPersistedConfig(userId, type, config);

        // Invalidate cached AI generator to ensure new config takes effect immediately
        flush_generator(userId);

        // Log for audit
        logger.info(
            `[CONFIG] User ${userId} updated ${type} config`,
        );

        return { success: true, type };
    });
