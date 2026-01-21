import { Elysia } from "elysia";
import { z } from "zod";
import { webhookService } from "../../core/services/webhooks";
import { WebhookCreateSchema } from "../../ai/schemas";
import { AppError } from "../errors";
import { normalizeUserId } from "../../utils";
import { getUser, verifyUserAccess } from "../middleware/auth";
import { UserContext } from "../../core/types";

/**
 * Webhook Management Routes.
 * Protected by 'memory:write' scope (or admin).
 */
export const webhookRoutes = (app: Elysia) => app.group("/webhooks", (app) => {
    return app
        /**
         * GET /webhooks
         * List all webhooks for the authenticated user.
         */
        .get("/", async (ctx) => {
            const user = getUser(ctx);
            const targetUserId = normalizeUserId((ctx.query.userId as string) || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User context missing");

            verifyUserAccess(user, targetUserId);

            const webhooks = await webhookService.list(targetUserId);
            return { hooks: webhooks };
        })

        /**
         * POST /webhooks
         * Create a new webhook.
         */
        .post("/", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const data = WebhookCreateSchema.parse(body);
            const targetUserId = normalizeUserId(data.userId || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User context missing");

            verifyUserAccess(user, targetUserId);

            // Generate a secure secret if not provided
            const secret = data.secret || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

            const webhook = await webhookService.create(
                targetUserId,
                data.url,
                data.events,
                secret
            );

            return { webhook };
        })

        /**
         * POST /webhooks/:id/test
         * Trigger a test event for a webhook.
         */
        .post("/:id/test", async ({ params, query, ...ctx }) => {
            const user = getUser(ctx);
            const targetUserId = normalizeUserId((query.userId as string) || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User context missing");

            verifyUserAccess(user, targetUserId);

            const id = params.id;
            const result = await webhookService.test(id, targetUserId);

            if (!result.success && result.error === "Webhook not found") {
                throw new AppError(404, "NOT_FOUND", "Webhook not found");
            }

            return { result };
        })

        /**
         * DELETE /webhooks/:id
         * Delete a webhook.
         */
        .delete("/:id", async ({ params, query, ...ctx }) => {
            const user = getUser(ctx);
            const targetUserId = normalizeUserId((query.userId as string) || user?.id);
            if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User context missing");

            verifyUserAccess(user, targetUserId);

            const id = params.id;
            const deleted = await webhookService.delete(id, targetUserId);
            if (!deleted) {
                throw new AppError(404, "NOT_FOUND", "Webhook not found or not owned by user");
            }

            return { success: true };
        });
});
