import { env } from "../../core/cfg";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import { compression_req } from "../../core/types";
import { compressionEngine } from "../../ops/compress";

export const compression = (app: Elysia) => {
    if (!env.compression_enabled) return;

    app.group("/api/compression", (app) =>
        app.post("/compress", async ({ body, set }) => {
            const b = body;
            try {
                const res = compressionEngine.compress(b.content, "semantic");
                return {
                    compressed: res.comp,
                    metrics: res.metrics
                };
            } catch (e: any) {
                log.error("Compression failed", { error: e.message });
                set.status = 500;
                return { err: e.message };
            }
        }, {
            body: t.Object({
                content: t.String()
            })
        })
    );
};
