import { env } from "../../core/cfg";
import { q, run_async, get_async, all_async, TABLE_MEMORIES, TABLE_STATS, TABLE_USERS } from "../../core/db";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";

export const req_tracker_plugin = (app: Elysia) => {
    let requests = 0;
    setInterval(() => {
        if (requests > 0) {
            run_async(
                `insert into ${TABLE_STATS}(type,count,ts) values('request',?,?)`,
                [requests, Date.now()],
            ).catch(e => log.error("Request stats logging failed", e));
            requests = 0;
        }
    }, 60000);

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
                        const dbp = env.db_path;
                        const file = Bun.file(dbp);
                        if (await file.exists()) {
                            dbSize = file.size;
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
            .get("/config", () => {
                return {
                    env: {
                        ...env,
                        api_key: "***",
                        openai_key: "***",
                    },
                };
            })
    );
