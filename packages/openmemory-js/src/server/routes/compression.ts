import { Elysia } from "elysia";
import { z } from "zod";
import { compressionEngine } from "../../ops/compress";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";
import { getUser } from "../middleware/auth";
import type { UserContext } from "../middleware/auth";

const CompressStatsSchema = z.object({});

const CompressTestSchema = z.object({
    text: z.string().min(1).max(100000), // Limit to 100KB for testing
    algorithm: z.enum(["semantic", "syntactic", "aggressive"]).optional(),
});

/**
 * Registers compression-related routes for testing and metrics.
 */
export const compressRoutes = (app: Elysia) => app.group("/api/compression", (app) => {
    return app
        /**
         * POST /api/compression/test
         * Tests compression on a text string.
         */
        .post("/test", async ({ body, ...ctx }) => {
            const { text, algorithm } = CompressTestSchema.parse(body);
            const user = getUser(ctx);

            let result;
            if (algorithm) {
                result = await compressionEngine.compress(
                    text,
                    algorithm,
                    user?.id,
                );
            } else {
                result = await compressionEngine.auto(text, user?.id);
            }

            return {
                success: true,
                result,
            };
        })

        /**
         * GET /api/compression/stats
         * Returns compression metrics. (Admin Only)
         */
        .get("/stats", async (ctx) => {
            const user = getUser(ctx);
            if (!user?.scopes.includes("admin:all")) {
                throw new AppError(403, "FORBIDDEN", "Unauthorized: Admin access required");
            }

            // getStats matches the API in ops/compress.ts
            const stats = compressionEngine.getStats();
            return {
                success: true,
                stats,
            };
        });
});
