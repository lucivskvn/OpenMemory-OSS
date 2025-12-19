import { env } from "../../core/cfg";
import { Elysia } from "elysia";
import { log } from "../../core/log";
import { compression_req } from "../../core/types";

export const compression = (app: Elysia) => {
    if (!env.compression_enabled) return;

    app.group("/compression", (app) =>
        app.post("/compress", async ({ body, set }) => {
            const b = body as compression_req;
            if (!b?.content) {
                set.status = 400;
                return { err: "missing_content" };
            }
            try {
                // Placeholder for compression logic
                // In a real implementation, we would import a compression utility
                return { compressed: b.content };
            } catch (e: any) {
                log.error("Compression failed", { error: e.message });
                set.status = 500;
                return { err: e.message };
            }
        })
    );
};
