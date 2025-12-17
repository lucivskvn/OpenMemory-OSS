import { env } from "../../core/cfg";
import { Elysia } from "elysia";

export const compression = (app: Elysia) => {
    if (!env.compression_enabled) return;

    app.group("/compression", (app) =>
        app.post("/compress", async ({ body, set }) => {
            const b = body as any;
            if (!b?.content) {
                set.status = 400;
                return { err: "missing_content" };
            }
            try {
                // Placeholder for compression logic
                return { compressed: b.content };
            } catch (e: any) {
                set.status = 500;
                return { err: e.message };
            }
        })
    );
};
