import { env } from "../../core/cfg";
import { q, run_async, get_async, all_async } from "../../core/db";
import { sector_configs } from "../../memory/hsg";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import pkg from "../../../package.json" with { type: "json" };

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
                    version: pkg.version || "unknown",
                    db: db_ok,
                    embed: embed_ok,
                    uptime: process.uptime(),
                };
            })
            .get("/logs", async ({ query, set }) => {
                try {
                    const l = query.limit ? Number(query.limit) : 100;
                    const logs = await q.get_recent_logs.all(l);
                    return { logs };
                } catch (e: any) {
                    log.error("Get logs failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                query: t.Object({
                    limit: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
    )
    // Add sectors endpoint at root to match tests/legacy behavior
    // Deprecated: use /api/memory/sectors
    .get("/sectors", () => {
        return { sectors: Object.keys(sector_configs) };
    });
