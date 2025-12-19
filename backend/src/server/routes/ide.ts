import { env } from "../../core/cfg";
import { q, run_async, get_async } from "../../core/db";
import { Elysia } from "elysia";
import { log } from "../../core/log";
import { ide_event_req, ide_context_query_req, ide_session_req } from "../../core/types";

export const ide = (app: Elysia) => {
    if (!env.ide_mode) return;

    app.group("/ide", (app) =>
        app
            .post("/events", async ({ body, set }) => {
                const b = body as ide_event_req;
                if (!b?.event || !b?.metadata) {
                    set.status = 400;
                    return { err: "missing_params" };
                }
                try {
                    // Logic to store IDE event (placeholder implementation)
                    log.info("IDE Event received", { type: b.event, session: b.session_id });
                    return { ok: true };
                } catch (err: any) {
                    log.error("Error storing IDE event", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
            .get("/context", async ({ query, set }) => {
                const q = query as unknown as ide_context_query_req; // Cast query params
                try {
                    // Logic to get context
                    return { context: [] };
                } catch (err: any) {
                    log.error("Error retrieving IDE context", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
            .post("/session/start", async ({ body, set }) => {
                const b = body as ide_session_req;
                try {
                    const id = crypto.randomUUID();
                    log.info("IDE Session started", { user: b.user, project: b.project, id });
                    return { session_id: id };
                } catch (err: any) {
                    log.error("Error starting IDE session", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
            .post("/session/end", async ({ body, set }) => {
                const b = body as { session_id: string };
                try {
                    log.info("IDE Session ended", { id: b.session_id });
                    return { ok: true };
                } catch (err: any) {
                    log.error("Error ending IDE session", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
            .post("/patterns", async ({ body, set }) => {
                try {
                    return { patterns: [] };
                } catch (err: any) {
                    log.error("Error detecting patterns", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
    );
};
