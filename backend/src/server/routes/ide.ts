import { env } from "../../core/cfg";
import { add_hsg_memory } from "../../memory/hsg";
import { j } from "../../utils";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import crypto from "crypto";

export const ide = (app: Elysia) => {
    if (!env.ide_mode) return;

    app.group("/ide", (app) =>
        app
            .post("/events", async ({ body, set }) => {
                const b = body;
                try {
                    // Safe metadata access
                    const meta = (b.metadata && typeof b.metadata === 'object') ? b.metadata : {};
                    const filename = meta.file || "unknown file";

                    // Store IDE event as a memory
                    const content = `IDE Event: ${b.event} in ${filename}\nContext: ${JSON.stringify(meta)}`;
                    const tags = ["ide", "event", b.event];
                    if (b.session_id) tags.push(`session:${b.session_id}`);

                    const res = await add_hsg_memory(
                        content,
                        j(tags),
                        { ...meta, type: "ide_event", session_id: b.session_id },
                        undefined
                    );

                    log.info("IDE Event stored", { id: res.id, type: b.event });
                    return { ok: true, id: res.id };
                } catch (err: any) {
                    log.error("Error storing IDE event", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                body: t.Object({
                    event: t.Union([
                        t.Literal("edit"), t.Literal("open"), t.Literal("close"),
                        t.Literal("save"), t.Literal("refactor"), t.Literal("comment"),
                        t.Literal("pattern_detected"), t.Literal("api_call"),
                        t.Literal("definition"), t.Literal("reflection")
                    ]),
                    file: t.Optional(t.String()),
                    snippet: t.Optional(t.String()),
                    comment: t.Optional(t.String()),
                    metadata: t.Optional(t.Any()), // Made optional to be safe
                    session_id: t.Optional(t.String())
                })
            })
            .get("/context", async ({ query, set }) => {
                try {
                    // Placeholder logic
                    return { context: [] };
                } catch (err: any) {
                    log.error("Error retrieving IDE context", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                query: t.Object({
                    query: t.String(),
                    k: t.Optional(t.Numeric()),
                    session_id: t.Optional(t.String()),
                    file_filter: t.Optional(t.String()),
                    include_patterns: t.Optional(t.Boolean()),
                    include_knowledge: t.Optional(t.Boolean())
                })
            })
            .post("/session/start", async ({ body, set }) => {
                const b = body;
                try {
                    const id = crypto.randomUUID();
                    log.info("IDE Session started", { user: b.user, project: b.project, id });
                    return { session_id: id };
                } catch (err: any) {
                    log.error("Error starting IDE session", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                body: t.Object({
                    user: t.Optional(t.String()),
                    project: t.Optional(t.String()),
                    ide: t.Optional(t.String())
                })
            })
            .post("/session/end", async ({ body, set }) => {
                const b = body;
                try {
                    log.info("IDE Session ended", { id: b.session_id });
                    return { ok: true };
                } catch (err: any) {
                    log.error("Error ending IDE session", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                body: t.Object({
                    session_id: t.String()
                })
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
