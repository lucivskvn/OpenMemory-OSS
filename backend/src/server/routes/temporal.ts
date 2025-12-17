import { Elysia } from "elysia";

export const temporal = (app: Elysia) =>
    app.group("/temporal", (app) =>
        app
            .post("/fact", async ({ body, set }) => {
                try {
                    return { ok: true };
                } catch (error: any) {
                    console.error('[TEMPORAL API] Error creating fact:', error)
                    set.status = 500;
                    return { error: error.message };
                }
            })
            .get("/fact", async ({ query, set }) => {
                try {
                    return { facts: [] };
                } catch (error: any) {
                    console.error('[TEMPORAL API] Error querying facts:', error)
                    set.status = 500;
                    return { error: error.message };
                }
            })
    );
