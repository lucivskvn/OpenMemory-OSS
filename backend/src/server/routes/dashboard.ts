import { env } from "../../core/cfg";
import { q, run_async, get_async, all_async } from "../../core/db";
import { get_memory_stats } from "../../memory/stats";
import { Elysia } from "elysia";
import { log } from "../../core/log";

export const req_tracker_plugin = (app: Elysia) => {
    let requests = 0;
    setInterval(() => {
        if (requests > 0) {
            run_async(
                "insert into stats(type,count,ts) values('request',?,?)",
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
                    const memoryStats = await get_memory_stats();
                    const totalMemories = await get_async(
                        "select count(*) as c from memories",
                    );
                    const totalUsers = await get_async("select count(*) as c from users");

                    let dbSize = 0;
                    if (env.metadata_backend === "sqlite") {
                        const dbp = env.db_path;
                        const file = Bun.file(dbp);
                        if (await file.exists()) {
                            dbSize = file.size;
                        }
                    }

                    const requestStats = await all_async(
                        "select * from stats where type='request' order by ts desc limit 60",
                    );
                    const maintenanceStats = await all_async(
                        "select * from stats where type in ('decay','reflect','consolidate') order by ts desc limit 50",
                    );

                    return {
                        overview: {
                            total_memories: totalMemories.c,
                            total_users: totalUsers.c,
                            db_size_bytes: dbSize,
                            uptime_seconds: process.uptime(),
                            active_segments: memoryStats.active_segments,
                        },
                        activity: requestStats.map((r) => ({
                            ts: r.ts,
                            count: r.count,
                        })),
                        maintenance: maintenanceStats,
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
                    const memories = await all_async(
                        "select * from memories order by created_at desc limit ? offset ?",
                        [limit, offset],
                    );
                    return { memories };
                } catch (e: any) {
                    log.error("Dashboard memories failed", { error: e.message });
                    set.status = 500;
                    return { error: "Failed to fetch memories" };
                }
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
