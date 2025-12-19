import { env } from "../../core/cfg";
import { Elysia } from "elysia";
import { log } from "../../core/log";
import { lgm_store_req, lgm_retrieve_req, lgm_context_req, lgm_reflection_req } from "../../core/types";

export const lg = (app: Elysia) => {
    if (env.mode !== "langgraph") return;

    app.group("/lg", (app) =>
        app
            .post("/store", async ({ body, set }) => {
                const b = body as lgm_store_req;
                try {
                    // Placeholder logic
                    return { ok: true };
                } catch (e: any) {
                    log.error("LangGraph store failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            })
            .post("/retrieve", async ({ body, set }) => {
                const b = body as lgm_retrieve_req;
                try {
                    // Placeholder logic
                    return { results: [] };
                } catch (e: any) {
                    log.error("LangGraph retrieve failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            })
            .get("/context", async ({ query, set }) => {
                const q = query as unknown as lgm_context_req;
                try {
                    // Placeholder logic
                    return { context: [] };
                } catch (e: any) {
                    log.error("LangGraph context failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            })
            .post("/reflection", async ({ body, set }) => {
                const b = body as lgm_reflection_req;
                try {
                    return { reflection: "mock reflection" };
                } catch (e: any) {
                    log.error("LangGraph reflection failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            })
    );
};
