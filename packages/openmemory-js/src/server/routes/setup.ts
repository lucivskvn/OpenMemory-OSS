import { Elysia } from "elysia";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";
import { toHex } from "../../utils";
import { setupTokenManager } from "../setupToken";

const VerifySetupSchema = z.object({
    userId: z.string().min(3),
    token: z.string().min(1),
});

/**
 * Registers Setup routes for initial system bootstrapping.
 */
export const setupRoutes = (app: Elysia) => app.group("/setup", (app) => {
    return app
        /**
         * GET /setup/status
         */
        .get("/status", () => {
            const token = setupTokenManager.get();
            return {
                setupMode: !!token,
                message: token
                    ? "Setup Mode Active. Check console logs for token."
                    : "System Initialized.",
            };
        })

        /**
         * POST /setup/verify
         * Body: { userId, token }
         */
        .post("/verify", async ({ body, request }) => {
            const { userId, token } = VerifySetupSchema.parse(body);

            // TODO: Implement strict rate limiting for setup if needed (5 attempts/15m)
            // Currently relying on global rate limit.

            if (!token || !setupTokenManager.verifyAndConsume(token)) {
                // Get IP from headers or standard request prop
                const ipInfo = app.server?.requestIP(request);
                const ip = ipInfo?.address || request.headers.get("x-forwarded-for") || "unknown";
                logger.warn(
                    `[SETUP] Verification failed. IP: ${ip} provided token: '${token ? "***" : "null"}'`,
                );
                throw new AppError(403, "INVALID_TOKEN", "Invalid or expired setup token.");
            }

            // Token Valid! Create Admin.
            const apiKeyBytes = new Uint8Array(32);
            crypto.getRandomValues(apiKeyBytes);
            const apiKey = "om_" + toHex(apiKeyBytes);

            const hashBuffer = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(apiKey),
            );
            const hash = toHex(hashBuffer);

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

            return {
                success: true,
                apiKey,
                userId,
                role: "admin",
            };
        });
});
