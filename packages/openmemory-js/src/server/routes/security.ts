
import { Elysia } from "elysia";
import { z } from "zod";
import { q } from "../../core/db";
import { AppError } from "../errors";
import { normalizeUserId } from "../../utils";
import { AuditQuerySchema } from "../../ai/schemas";
import { getUser } from "../middleware/auth";
import type { UserContext } from "../middleware/auth";

/**
 * Security Routes
 * Exposed endpoints for Audit Logs.
 */
export const securityRoutes = (app: Elysia) => app.group("/audit-logs", (app) => {
    return app
        /**
         * GET /audit-logs
         * Query audit trail.
         * Users see their own logs. Admins can filter by userId.
         */
        .get("/", async ({ query, ...ctx }) => {
            const { userId: queryUser, action, resourceType, limit } = AuditQuerySchema.parse(query);
            const user = getUser(ctx);
            if (!user) throw new AppError(401, "UNAUTHORIZED", "User context required");

            const isAdmin = user.scopes.includes("admin:all");
            let targetUser = normalizeUserId(user.id);

            if (isAdmin) {
                if (queryUser === undefined) {
                    // Admin explicit global view (no user filter)
                    targetUser = null;
                } else {
                    targetUser = normalizeUserId(queryUser);
                }
            } else if (queryUser && normalizeUserId(queryUser) !== targetUser) {
                // Non-admin trying to query another user
                throw new AppError(403, "FORBIDDEN", "Cannot query other users' audit logs");
            }

            const logs = await q.auditQuery.all(
                targetUser || null,
                action || null,
                resourceType || null,
                null,
                null,
                limit
            );

            return { success: true, logs };
        });
});
