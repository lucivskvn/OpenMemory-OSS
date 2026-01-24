import { Elysia } from "elysia";
import { z } from "zod";

import { q } from "../../core/db";
import { Memory } from "../../core/memory";
import {
    autoUpdateUserSummaries,
    updateUserSummary,
} from "../../memory/userSummary";
import { normalizeUserId } from "../../utils";
import { AppError } from "../errors";
import { verifyUserAccess, getUser } from "../middleware/auth";
import {
    ContentValidationSchema,
    MetadataValidationSchema,
    TagsValidationSchema,
    UserIdValidationSchema,
    createInputValidator,
} from "../../utils/inputSanitization";

// --- Enhanced Schemas with Security Validation ---

const UserIdSchema = z.object({
    userId: UserIdValidationSchema,
});

const ListMemoriesQuerySchema = z.object({
    l: z.coerce.number().max(1000).default(100), // limit
    u: z.coerce.number().default(0), // offset
});

/**
 * User API Routes
 * Handles user profiles, summaries, and memory lists.
 */
export const userRoutes = (app: Elysia) => app.group("/users", (app) => {
    return app
        /**
         * GET /users
         * Lists all active users (Admin Only).
         */
        .get("/", async (ctx) => {
            const user = getUser(ctx);
            if (!user || (!user.scopes.includes("admin:all"))) {
                throw new AppError(403, "FORBIDDEN", "Admin access required");
            }

            const users = await q.getActiveUsers.all() as { userId: string }[];
            return { success: true, users: users.map((u) => u.userId) };
        })

        /**
         * POST /users/summaries/regenerate-all
         * Admin Only.
         */
        .post("/summaries/regenerate-all", async (ctx) => {
            const user = getUser(ctx);
            if (!user || !user.scopes.includes("admin:all")) {
                throw new AppError(403, "FORBIDDEN", "Admin access required");
            }

            const result = await autoUpdateUserSummaries();
            return { success: true, updated: result.updated };
        })

        /**
         * GET /users/:userId
         */
        .get("/:userId", async ({ params, ...ctx }) => {
            const user = getUser(ctx);
            const p = UserIdSchema.parse(params);
            const rawUserId = normalizeUserId(p.userId);

            // Verify Access
            const targetUserId = verifyUserAccess(user, rawUserId);
            if (!targetUserId) throw new AppError(400, "INVALID_ID", "Invalid user ID or Access Denied");

            const userData = await q.getUser.get(targetUserId);
            if (!userData) throw new AppError(404, "NOT_FOUND", "User not found");

            return userData;
        })

        /**
         * GET /users/:userId/summary
         */
        .get("/:userId/summary", async ({ params, ...ctx }) => {
            const user = getUser(ctx);
            const p = UserIdSchema.parse(params);
            const rawUserId = normalizeUserId(p.userId);

            const targetUserId = verifyUserAccess(user, rawUserId);
            if (!targetUserId) throw new AppError(400, "INVALID_ID", "Invalid user ID or Access Denied");

            const userData = await q.getUser.get(targetUserId);
            if (!userData) throw new AppError(404, "NOT_FOUND", "User not found");

            return {
                success: true,
                userId: userData.userId,
                summary: userData.summary,
                reflectionCount: userData.reflectionCount,
                updatedAt: userData.updatedAt,
            };
        })

        /**
         * POST /users/:userId/summary/regenerate
         */
        .post("/:userId/summary/regenerate", async ({ params, ...ctx }) => {
            const user = getUser(ctx);
            const p = UserIdSchema.parse(params);
            const rawUserId = normalizeUserId(p.userId);

            const targetUserId = verifyUserAccess(user, rawUserId);
            if (!targetUserId) throw new AppError(400, "INVALID_ID", "Invalid user ID or Access Denied");

            await updateUserSummary(targetUserId);
            const userData = await q.getUser.get(targetUserId);

            return {
                success: true,
                userId: targetUserId,
                summary: userData?.summary,
                reflectionCount: userData?.reflectionCount,
            };
        })

        /**
         * GET /users/:userId/memories
         */
        .get("/:userId/memories", async ({ params, query, ...ctx }) => {
            const user = getUser(ctx);
            const p = UserIdSchema.parse(params);
            const qParams = ListMemoriesQuerySchema.parse(query);
            const rawUserId = normalizeUserId(p.userId);

            const targetUserId = verifyUserAccess(user, rawUserId);
            if (!targetUserId) throw new AppError(400, "INVALID_ID", "Invalid user ID or Access Denied");

            const m = new Memory(targetUserId);
            const items = await m.list(qParams.l, qParams.u);

            return { userId: targetUserId, items };
        })

        /**
         * DELETE /users/:userId/memories
         * Wipe memories.
         */
        .delete("/:userId/memories", async ({ params, ...ctx }) => {
            const user = getUser(ctx);
            const p = UserIdSchema.parse(params);
            const rawUserId = normalizeUserId(p.userId);

            const targetUserId = verifyUserAccess(user, rawUserId);
            if (!targetUserId) throw new AppError(400, "INVALID_ID", "Invalid user ID or Access Denied");

            const m = new Memory(targetUserId);
            const deleted = await m.wipeUserContent(targetUserId);

            return { success: true, deleted };
        })

        /**
         * DELETE /users/:userId
         * GDPR delete.
         */
        .delete("/:userId", async ({ params, ...ctx }) => {
            const user = getUser(ctx);
            const p = UserIdSchema.parse(params);
            const rawUserId = normalizeUserId(p.userId);

            // verifyUserAccess returns targetUserId if allowed.
            // But for DELETING a user, should a normal user be able to delete themselves?
            // Yes, GDPR. 'verifyUserAccess' allows self or admin.
            const targetUserId = verifyUserAccess(user, rawUserId);
            if (!targetUserId) throw new AppError(400, "INVALID_ID", "Invalid user ID or Access Denied");

            await q.delUserCascade.run(targetUserId);

            return {
                success: true,
                message: `User ${targetUserId} and all data deleted.`,
            };
        });
});
