import { logger } from "../../utils/logger";
import { AppError, sendError } from "../errors";
import { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";
import { setupTokenManager } from "../setup_token";

/**
 * Registers Setup routes for initial system bootstrapping.
 * @param app Server app instance
 */
export const setupRoutes = (app: ServerApp) => {
    /**
     * GET /setup/status
     */
    app.get(
        "/setup/status",
        async (_req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const token = setupTokenManager.get();
                res.json({
                    setupMode: !!token,
                    message: token
                        ? "Setup Mode Active. Check console logs for token."
                        : "System Initialized.",
                });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    /**
     * POST /setup/verify
     * Body: { userId, token }
     */
    app.post(
        "/setup/verify",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { userId, token } = (req.body || {}) as {
                    userId?: string;
                    token?: string;
                };

                if (!token || !setupTokenManager.verifyAndConsume(token)) {
                    logger.warn(
                        `[SETUP] Verification failed. IP: ${req.ip} provided token: '${token ? "***" : "null"}'`,
                    );
                    // If invalid token, return 403.
                    // Note: consume happens on match. If mismatch, we don't consume?
                    // `verifyAndConsume` implementation: check match -> consume.
                    return sendError(
                        res,
                        new AppError(
                            403,
                            "INVALID_TOKEN",
                            "Invalid or expired setup token.",
                        ),
                    );
                }

                if (
                    !userId ||
                    typeof userId !== "string" ||
                    userId.length < 3
                ) {
                    return sendError(
                        res,
                        new AppError(
                            400,
                            "INVALID_USER_ID",
                            "UserId required.",
                        ),
                    );
                }

                // Token Valid! Create Admin.
                const apiKeyBytes = new Uint8Array(32);
                globalThis.crypto.getRandomValues(apiKeyBytes);
                const apiKey = "om_" + Buffer.from(apiKeyBytes).toString("hex");

                const hashBuffer = await globalThis.crypto.subtle.digest(
                    "SHA-256",
                    Buffer.from(apiKey),
                );
                const hash = Buffer.from(hashBuffer).toString("hex");

                const { q } = await import("../../core/db");
                const now = Date.now();

                await q.insApiKey.run(
                    hash,
                    userId,
                    "admin",
                    "Root Admin created via Console Token",
                    now,
                    now,
                    0,
                );

                logger.info(`[SETUP] Admin created: ${userId}`);

                res.json({
                    success: true,
                    apiKey,
                    userId,
                    role: "admin",
                });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );
};
