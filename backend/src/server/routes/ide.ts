import { env } from "../../core/cfg";
import { add_hsg_memory, hsg_query } from "../../memory/hsg";
import { j } from "../../utils";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import crypto from "crypto";

export const ide = (app: Elysia) => {
    if (!env.ide_mode) return app;

    return app.group("/api/ide", (app) =>
        app
            .post("/events", async ({ body }) => {
                const b = body;
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
            .post("/context", async ({ body }) => {
                const b = body;
                // Use hsg_query to find relevant memories
                const k = b.limit || 10;

                // TODO: Enhance hsg_query to support tag filtering for session_id if needed

                const memories = await hsg_query(b.query, k);

                return {
                    memories: memories.map((m: any) => ({
                        id: m.id,
                        content: m.content,
                        score: m.score,
                        sector: m.primary_sector
                    }))
                };
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
            .post("/session/start", async ({ body }) => {
                const b = body;
                const id = crypto.randomUUID();
                log.info("IDE Session started", { user: b.user_id, project: b.project_name, id });
                return { session_id: id };
            }, {
                body: t.Object({
                    user_id: t.Optional(t.String()),
                    project_name: t.Optional(t.String()),
                    ide_name: t.Optional(t.String())
                })
            })
            .post("/session/end", async ({ body }) => {
                const b = body;
                log.info("IDE Session ended", { id: b.session_id });
                return { ok: true };
            }, {
                body: t.Object({
                    session_id: t.String(),
                    user_id: t.Optional(t.String())
                })
            })
            .get("/patterns/:sid", async ({ params }) => {
                // Placeholder for now
                return { patterns: [] };
            }, {
                params: t.Object({
                    sid: t.String()
                })
            })
    );
};
