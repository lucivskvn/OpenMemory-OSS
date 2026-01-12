import { z } from "zod";

import { q } from "../../core/db";
import { Memory } from "../../core/memory";
// MemoryRow unused after refactor to Memory Facade
import {
    autoUpdateUserSummaries,
    updateUserSummary,
} from "../../memory/user_summary";
import { normalizeUserId } from "../../utils";
import { AppError, sendError } from "../errors";
import { verifyUserAccess } from "../middleware/auth";
import {
    validateParams,
    validateQuery,
} from "../middleware/validate";

const UserIdSchema = z.object({
    userId: z.string().min(1),
});

const ListMemoriesQuerySchema = z.object({
    l: z.coerce.number().default(100), // limit
    u: z.coerce.number().default(0), // offset
});

import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

export const userRoutes = (app: ServerApp) => {
    /**
     * GET /users
     * Lists all active users in the system.
     */
    app.get("/users", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const isAdmin = (req.user?.scopes || []).includes("admin:all");
            if (!isAdmin) {
                return sendError(
                    res,
                    new AppError(403, "FORBIDDEN", "Admin access required"),
                );
            }

            const users = await q.getActiveUsers.all();
            res.json({ users: users.map((u) => u.userId) });
        } catch (err: unknown) {
            sendError(res, err);
        }
    });

    /**
     * GET /users/:userId
     * Retrieves the profile and metadata for a specific user.
     */
    app.get(
        "/users/:userId",
        validateParams(UserIdSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const userId = normalizeUserId(req.params.userId);
                // Security: Users can only see their own profile, unless they are admin
                verifyUserAccess(req, userId);

                if (userId === null)
                    return sendError(
                        res,
                        new AppError(400, "INVALID_ID", "Invalid user ID"),
                    );

                const user = await q.getUser.get(userId);
                if (!user)
                    return sendError(
                        res,
                        new AppError(404, "NOT_FOUND", "user not found"),
                    );
                res.json(user);
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    /**
     * GET /users/:userId/summary
     * Retrieves the AI-generated personality/activity summary for a user.
     */
    app.get(
        "/users/:userId/summary",
        validateParams(UserIdSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const userId = normalizeUserId(req.params.userId);
                verifyUserAccess(req, userId);

                if (userId === null)
                    return sendError(
                        res,
                        new AppError(400, "INVALID_ID", "Invalid user ID"),
                    );

                const user = await q.getUser.get(userId);
                if (!user)
                    return sendError(
                        res,
                        new AppError(404, "NOT_FOUND", "User not found"),
                    );

                res.json({
                    userId: user.userId,
                    summary: user.summary,
                    reflectionCount: user.reflectionCount,
                    updatedAt: user.updatedAt,
                });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    /**
     * POST /users/:userId/summary/regenerate
     * Manually triggers a regeneration of the user summary.
     */
    app.post(
        "/users/:userId/summary/regenerate",
        validateParams(UserIdSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const userId = normalizeUserId(req.params.userId);

                verifyUserAccess(req, userId);

                if (userId === null || userId === undefined)
                    return sendError(
                        res,
                        new AppError(400, "INVALID_ID", "Invalid user ID"),
                    );

                await updateUserSummary(userId);
                const user = await q.getUser.get(userId);

                res.json({
                    ok: true,
                    userId,
                    summary: user?.summary,
                    reflectionCount: user?.reflectionCount,
                });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    /**
     * POST /users/summaries/regenerate-all
     * Triggers summary regeneration for all active users (Admin only recommended).
     */
    app.post(
        "/users/summaries/regenerate-all",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                if (!isAdmin) {
                    return sendError(
                        res,
                        new AppError(403, "FORBIDDEN", "Admin access required"),
                    );
                }

                const result = await autoUpdateUserSummaries();
                res.json({ ok: true, updated: result.updated });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    /**
     * GET /users/:userId/memories
     * Lists memories owned by a specific user.
     */
    app.get(
        "/users/:userId/memories",
        validateParams(UserIdSchema),
        validateQuery(ListMemoriesQuerySchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const userId = normalizeUserId(req.params.userId);

                verifyUserAccess(req, userId);

                if (userId === null)
                    return sendError(
                        res,
                        new AppError(400, "INVALID_ID", "Invalid user ID"),
                    );

                const { l, u } = req.query as unknown as z.infer<
                    typeof ListMemoriesQuerySchema
                >;

                const m = new Memory(userId);
                const items = await m.list(l, u);

                res.json({ userId, items });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    /**
     * DELETE /users/:userId/memories
     * Wipes all memories and associated vectors for a specific user.
     */
    app.delete(
        "/users/:userId/memories",
        validateParams(UserIdSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const userId = normalizeUserId(req.params.userId);
                verifyUserAccess(req, userId);

                if (userId === null)
                    return sendError(
                        res,
                        new AppError(400, "INVALID_ID", "Invalid user ID"),
                    );

                // Use Core Memory logic
                const m = new Memory(userId);
                const deleted = await m.wipeUserContent(userId!);

                res.json({ ok: true, deleted });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    /*
     * Deprecated routes (register, keys) have been removed.
     * Please use /admin/users and /admin/keys routes instead.
     */
};
