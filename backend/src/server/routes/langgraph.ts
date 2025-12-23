import { env } from "../../core/cfg";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import { store_node_mem, retrieve_node_mems, get_graph_ctx, create_refl } from "../../ai/graph";

export const lg = (app: Elysia) => {
    if (env.mode !== "langgraph") return;

    app.group("/api/lg", (app) =>
        app
            .post("/store", async ({ body, set }) => {
                const b = body;
                try {
                    const res = await store_node_mem(b);
                    return { ok: true, ...res };
                } catch (e: any) {
                    log.error("LangGraph store failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            }, {
                body: t.Object({
                    node: t.String(),
                    content: t.String(),
                    namespace: t.Optional(t.String()),
                    graph_id: t.Optional(t.String()),
                    tags: t.Optional(t.Array(t.String())),
                    metadata: t.Optional(t.Any()),
                    reflective: t.Optional(t.Boolean()),
                    user_id: t.Optional(t.String())
                })
            })
            .post("/retrieve", async ({ body, set }) => {
                const b = body;
                try {
                    const res = await retrieve_node_mems(b);
                    return { results: res.items, count: res.count };
                } catch (e: any) {
                    log.error("LangGraph retrieve failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            }, {
                body: t.Object({
                    node: t.String(),
                    query: t.Optional(t.String()),
                    namespace: t.Optional(t.String()),
                    graph_id: t.Optional(t.String()),
                    limit: t.Optional(t.Numeric()),
                    include_metadata: t.Optional(t.Boolean())
                })
            })
            .get("/context", async ({ query, set }) => {
                try {
                    const res = await get_graph_ctx({
                        namespace: query.namespace,
                        graph_id: query.graph_id,
                        limit: query.limit ? Number(query.limit) : undefined
                    });
                    return { context: res.nodes, summary: res.summary };
                } catch (e: any) {
                    log.error("LangGraph context failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            }, {
                query: t.Object({
                    namespace: t.Optional(t.String()),
                    graph_id: t.Optional(t.String()),
                    limit: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            .post("/reflection", async ({ body, set }) => {
                const b = body;
                try {
                    const res = await create_refl(b);
                    return { reflection: res };
                } catch (e: any) {
                    log.error("LangGraph reflection failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            }, {
                body: t.Object({
                    node: t.Optional(t.String()),
                    namespace: t.Optional(t.String()),
                    graph_id: t.Optional(t.String()),
                    content: t.Optional(t.String()),
                    context_ids: t.Optional(t.Array(t.String()))
                })
            })
    );
};
