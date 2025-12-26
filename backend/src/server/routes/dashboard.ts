import { env } from "../../core/cfg";
import { q, run_async, get_async, all_async, TABLE_MEMORIES, TABLE_STATS, TABLE_USERS } from "../../core/db";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";

export const req_tracker_plugin = (app: Elysia) => {
    let requests = 0;
    // Buffer requests and flush periodically
    const timer = setInterval(() => {
        if (requests > 0) {
            q.log_request_stat.run(requests, Date.now())
                .catch(e => log.error("Request stats logging failed", { error: e.message }));
            requests = 0;
        }
    }, 60000);

    // Unref to avoid holding process up
    if (timer.unref) timer.unref();

    return app.onRequest(() => {
        requests++;
    });
};

export const dash = (app: Elysia) =>
    app.group("/api/dashboard", (app) =>
        app
            .get("/stats", async ({ set }) => {
                try {
                    const stats = await q.get_system_stats.get();

                    let dbSize = 0;
                    if (env.metadata_backend === "sqlite") {
                        try {
                            const dbp = env.db_path;
                            const file = Bun.file(dbp);
                            if (await file.exists()) {
                                dbSize = file.size;
                            }
                        } catch (e) {
                            // ignore FS errors
                        }
                    }

                    return {
                        overview: {
                            total_memories: stats.totalMemories.c,
                            total_users: stats.totalUsers.c,
                            db_size_bytes: dbSize,
                            uptime_seconds: process.uptime(),
                            active_segments: stats.activeSegments,
                        },
                        activity: stats.requestStats.map((r: any) => ({
                            ts: r.ts,
                            count: r.count,
                        })),
                        maintenance: stats.maintenanceStats,
                    };
                } catch (e: any) {
                    log.error("Dashboard stats failed", { error: e.message });
                    set.status = 500;
                    return { error: "Failed to fetch stats" };
                }
            })
            .get("/memories", async ({ query, set }) => {
                try {
                    const limit = Number(query.limit) || 20;
                    const offset = Number(query.offset) || 0;
                    const memories = await q.all_mem.all(limit, offset);
                    return { memories };
                } catch (e: any) {
                    log.error("Dashboard memories failed", { error: e.message });
                    set.status = 500;
                    return { error: "Failed to fetch memories" };
                }
            }, {
                query: t.Object({
                    limit: t.Optional(t.Union([t.String(), t.Numeric()])),
                    offset: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            .get("/activity", async ({ query, set }) => {
                try {
                    const limit = Number(query.limit) || 50;
                    const activities = await q.get_recent_activity.all(limit);
                    return {
                        activities: activities.map((a: any) => ({
                            id: a.id,
                            timestamp: a.updated_at,
                            content: a.content,
                            sector: a.primary_sector,
                            salience: a.salience,
                            type: a.created_at === a.updated_at ? "memory_created" : "memory_updated"
                        }))
                    };
                } catch (e: any) {
                    log.error("Dashboard activity failed", { error: e.message });
                    set.status = 500;
                    return { error: "Failed to fetch activity" };
                }
            }, {
                query: t.Object({
                    limit: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            .get("/config", () => {
                const safeEnv = { ...env } as Record<string, any>;
                const sensitive = [
                    "api_key", "openai_key", "gemini_key", "AWS_SECRET_ACCESS_KEY",
                    "valkey_password"
                ];
                for (const k of sensitive) {
                    if (safeEnv[k]) safeEnv[k] = "***";
                }
                return { env: safeEnv };
            })
    );
