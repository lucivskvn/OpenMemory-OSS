import { env } from "../../core/cfg";
import { add_hsg_memory, hsg_query } from "../../memory/hsg";
import { j } from "../../utils";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import crypto from "crypto";

export const ide = (app: Elysia) => {
    if (!env.ide_mode) return;

    app.group("/api/ide", (app) =>
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
                    file_path: t.Optional(t.String()),
                    language: t.Optional(t.String()),
                    content: t.Optional(t.String()),
                    metadata: t.Optional(t.Any()),
                    session_id: t.Optional(t.String()),
                    user_id: t.Optional(t.String()),
                    timestamp: t.Optional(t.String())
                })
            })
            .post("/context", async ({ body, set }) => {
                const b = body;
                try {
                    // Use hsg_query to find relevant memories
                    const k = b.limit || 10;
                    const filters: any = {};
                    if (b.session_id) filters.session_id = b.session_id; // hsg_query might not support session_id natively yet, but we can filter or use tag matching

                    // Actually hsg_query supports filtering by sectors/user_id etc.
                    // Ideally we should use session_id as a tag filter?
                    // "session:123"

                    if (b.session_id) {
                        // TODO: Implement tag filtering in hsg_query interface properly
                    }

                    const memories = await hsg_query(b.query, k);

                    return {
                        memories: memories.map((m: any) => ({
                            id: m.id,
                            content: m.content,
                            score: m.score,
                            sector: m.primary_sector
                        }))
                    };
                } catch (err: any) {
                    log.error("Error retrieving IDE context", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                body: t.Object({
                    query: t.String(),
                    limit: t.Optional(t.Numeric()),
                    session_id: t.Optional(t.String()),
                    file_path: t.Optional(t.String()),
                    include_patterns: t.Optional(t.Boolean()),
                    include_knowledge: t.Optional(t.Boolean())
                })
            })
            .post("/session/start", async ({ body, set }) => {
                const b = body;
                try {
                    const id = crypto.randomUUID();
                    log.info("IDE Session started", { user: b.user_id, project: b.project_name, id });
                    return { session_id: id };
                } catch (err: any) {
                    log.error("Error starting IDE session", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                body: t.Object({
                    user_id: t.Optional(t.String()),
                    project_name: t.Optional(t.String()),
                    ide_name: t.Optional(t.String())
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
                    session_id: t.String(),
                    user_id: t.Optional(t.String())
                })
            })
            .get("/patterns/:sid", async ({ params, set }) => {
                try {
                    // Placeholder for now
                    return { patterns: [] };
                } catch (err: any) {
                    log.error("Error retrieving patterns", { error: err.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                params: t.Object({
                    sid: t.String()
                })
            })
    );
};
