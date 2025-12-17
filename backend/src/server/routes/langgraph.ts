import { env } from "../../core/cfg";
import { Elysia } from "elysia";

export const lg = (app: Elysia) => {
    if (env.mode !== "langgraph") return;

    app.group("/lg", (app) =>
        app
            .post("/store", async ({ body, set }) => {
                try {
                    return { ok: true };
                } catch (e: any) {
                    console.error("[LGM] store error:", e);
                    set.status = 500;
                    return { err: e.message };
                }
            })
            .post("/retrieve", async ({ body, set }) => {
                try {
                    return { results: [] };
                } catch (e: any) {
                    console.error("[LGM] retrieve error:", e);
                    set.status = 500;
                    return { err: e.message };
                }
            })
            .get("/context", async ({ set }) => {
                try {
                    return { context: [] };
                } catch (e: any) {
                    console.error("[LGM] context error:", e);
                    set.status = 500;
                    return { err: e.message };
                }
            })
            .post("/reflection", async ({ body, set }) => {
                try {
                    return { reflection: "mock reflection" };
                } catch (e: any) {
                    console.error("[LGM] reflection error:", e);
                    set.status = 500;
                    return { err: e.message };
                }
            })
    );
};
