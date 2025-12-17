import { env } from "../../core/cfg";
import { q, run_async, get_async, all_async } from "../../core/db";
import { sector_configs } from "../../memory/hsg";
import { Elysia } from "elysia";

export const sys = (app: Elysia) =>
    app.group("/api/system", (app) =>
        app
            .get("/health", async ({ set }) => {
                const db_ok = await get_async("select 1 as c")
                    .then(() => true)
                    .catch(() => false);
                const embed_ok = true; // assume synthetic for now or check url
                const status = db_ok ? "ok" : "degraded";
                set.status = status === "ok" ? 200 : 503;
                return {
                    status,
                    version: "1.2.2",
                    db: db_ok,
                    embed: embed_ok,
                    uptime: process.uptime(),
                };
            })
            .get("/logs", async ({ query, set }) => {
                try {
                    const l = Number(query.limit) || 100;
                    const logs = await all_async(
                        "select * from embed_logs order by ts desc limit ?",
                        [l],
                    );
                    return { logs };
                } catch (e) {
                    set.status = 500;
                    return { err: "internal" };
                }
            })
    )
    // Add sectors endpoint at root to match tests/legacy behavior
    .get("/sectors", () => {
        return { sectors: Object.keys(sector_configs) };
    });
