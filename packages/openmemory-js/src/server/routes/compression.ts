import { z } from "zod";

import { compressionEngine } from "../../ops/compress";
import { logger } from "../../utils/logger";
import { sendError } from "../errors";
import { validateBody, validateQuery } from "../middleware/validate";
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

const CompressStatsSchema = z.object({});

const CompressTestSchema = z.object({
    text: z.string().min(1).max(100000), // Limit to 100KB for testing
    algorithm: z.enum(["semantic", "syntactic", "aggressive"]).optional(),
});

/**
 * Registers compression-related routes for testing and metrics.
 * @param app The server application instance.
 */
export function compressRoutes(app: ServerApp) {
    /**
     * POST /api/compression/test
     * Tests compression on a text string.
     */
    app.post(
        "/api/compression/test",
        validateBody(CompressTestSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { text, algorithm } = req.body as z.infer<
                    typeof CompressTestSchema
                >;

                let result;
                if (algorithm) {
                    result = await compressionEngine.compress(
                        text,
                        algorithm,
                        req.user?.id,
                    );
                } else {
                    result = await compressionEngine.auto(text, req.user?.id);
                }

                res.json({
                    success: true,
                    result,
                });
            } catch (err: unknown) {
                logger.error("[COMPRESS] Test error:", { error: err });
                sendError(res, err);
            }
        },
    );

    /**
     * GET /api/compression/stats
     * Returns compression metrics. (Admin Only)
     */
    app.get(
        "/api/compression/stats",
        validateQuery(CompressStatsSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                if (!req.user?.scopes?.includes("admin:all")) {
                    res.status(403).json({
                        success: false,
                        error: "Unauthorized: Admin access required",
                    });
                    return;
                }

                // getStats matches the API in ops/compress.ts
                const stats = compressionEngine.getStats();
                res.json({
                    success: true,
                    stats,
                });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );
}
