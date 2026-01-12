
import { z } from "zod";

import { q } from "../../core/db";
import { AppError, sendError } from "../errors";
import { validateBody, validateQuery } from "../middleware/validate";
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

/**
 * Admin API Routes
 * Centralized management for Users, Keys, and Source Configurations (MCP).
 * Strictly protected by `admin:all` scope.
 */

// --- Schemas ---

const UserIdParamSchema = z.object({
    userId: z.string(),
});

const CreateUserSchema = z.object({
    userId: z.string().min(1),
    summary: z.string().optional(),
});

const CreateKeySchema = z.object({
    role: z.enum(["user", "admin", "read_only"]).default("user"),
    note: z.string().optional(),
    expiresInDays: z.number().optional().default(0), // 0 = never
});

const CreateSourceSchema = z.object({
    type: z.string().min(1),
    config: z.string().min(1), // JSON String or identifying string
    status: z.enum(["enabled", "disabled"]).default("enabled"),
});

// --- Middleware ---

import { Memory } from "../../core/memory";
import { requireAdmin } from "../middleware/auth";

const ListUsersQuerySchema = z.object({
    l: z.coerce.number().default(100),
    u: z.coerce.number().default(0),
});

export function adminRoutes(app: ServerApp) {

    // --- User Management ---

    /**
     * GET /admin/users
     * List all active users (Paginated).
     */
    app.get("/admin/users", requireAdmin, validateQuery(ListUsersQuerySchema), async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { l, u } = req.query as unknown as z.infer<typeof ListUsersQuerySchema>;
            // Optimized query
            const users = await q.getUsers.all(l, u);
            res.json({ users });
        } catch (e) {
            sendError(res, e);
        }
    });

    /**
     * POST /admin/users
     * Create or reactivate a user.
     */
    app.post("/admin/users", requireAdmin, validateBody(CreateUserSchema), async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { userId, summary } = req.body as { userId: string; summary?: string };
            await q.insUser.run(userId, summary || "", 0, Date.now(), Date.now());
            res.json({ success: true, userId });
        } catch (e) {
            sendError(res, e);
        }
    });

    /**
     * DELETE /admin/users/:userId
     * Delete a user and ALL their data (cascade).
     */
    app.delete("/admin/users/:userId", requireAdmin, async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { userId } = req.params;
            if (!userId) throw new AppError(400, "BAD_REQUEST", "UserId required");

            // Cascade Delete via Memory Facade (Consistency)
            // This handles memories, vectors, facts, edges, waypoints, etc.
            const m = new Memory(userId); // context is target user for wipe
            await m.wipeUserContent(userId);

            // Additional cleanups not covered by Memory facade (User record, Keys, Configs)
            await q.delSourceConfigsByUser.run(userId);
            // delFacts, delEdges etc are handled by wipeUserContent (calls q.delMemByUser which cascades)
            // WAIT, q.delMemByUser implementation in db.ts lines 1680+ deletes facts/edges/models/memories/vectors.
            // But does it delete Source Configs? No.
            // Does it delete Waypoints? Yes.

            // So we need to delete Source Configs explicitly.

            // Delete Keys? Not explicitly in cascade list in db.ts interface, let's check
            // We should delete keys too.
            // Need to implement delApiKeysByUser or just iterate.
            const keys = await q.getApiKeysByUser.all(userId);
            for (const k of keys) await q.delApiKey.run(k.keyHash);

            await q.delUser.run(userId);

            res.json({ success: true, userId });
        } catch (e) {
            sendError(res, e);
        }
    });


    // --- API Key Management (Per User) ---

    /**
     * GET /admin/users/:userId/keys
     * List API keys for a specific user.
     */
    app.get("/admin/users/:userId/keys", requireAdmin, async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { userId } = req.params;
            if (!userId) throw new AppError(400, "BAD_REQUEST", "UserId required");
            const keys = await q.getApiKeysByUser.all(userId);
            res.json({ keys });
        } catch (e) {
            sendError(res, e);
        }
    });

    /**
     * POST /admin/users/:userId/keys
     * Generate a new API key for a user.
     */
    app.post("/admin/users/:userId/keys", requireAdmin, validateBody(CreateKeySchema), async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { userId } = req.params;
            if (!userId) throw new AppError(400, "BAD_REQUEST", "UserId required");
            const { role, note, expiresInDays } = req.body as { role: string; note?: string; expiresInDays: number };

            const rawKey = `om_${crypto.randomUUID().replace(/-/g, "")}`;
            const keyHashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
            const keyHash = Buffer.from(keyHashBuffer).toString("hex");

            const expiresAt = expiresInDays > 0 ? Date.now() + (expiresInDays * 24 * 60 * 60 * 1000) : 0;

            await q.insApiKey.run(keyHash, userId, role, note || null, Date.now(), Date.now(), expiresAt);

            // Return the RAW key once
            res.json({ success: true, key: rawKey, note, expiresAt });
        } catch (e) {
            sendError(res, e);
        }
    });

    /**
     * DELETE /admin/keys/:keyHash
     * Revoke a specific key (by Hash, or maybe we need ID? DB uses Hash as ID).
     * CAUTION: Admins usually see partial keys or IDs. 
     * If DB only stores Hash, we can't easily select by "ID" unless we add an ID column.
     * `q.delApiKey` takes `keyHash`.
     * Admin UI would iterate keys, show the Hash (or masked), and send Hash to delete.
     */
    app.delete("/admin/keys/:keyHash", requireAdmin, async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { keyHash } = req.params;
            if (!keyHash) throw new AppError(400, "BAD_REQUEST", "KeyHash required");
            await q.delApiKey.run(keyHash);
            res.json({ success: true });
        } catch (e) {
            sendError(res, e);
        }
    });


    // --- Source/MCP Configuration Management (Per User) ---

    /**
     * GET /admin/users/:userId/sources
     * List all source configs (MCP, integrations) for a user.
     * Security: Returns metadata ONLY. Secrets are Write-Only.
     */
    app.get("/admin/users/:userId/sources", requireAdmin, async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { userId } = req.params;
            if (!userId) throw new AppError(400, "BAD_REQUEST", "UserId required");
            const sources = await q.getSourceConfigsByUser.all(userId);
            // Mask config data. 
            const safeSources = sources.map(s => ({
                userId: s.userId,
                type: s.type,
                status: s.status,
                updatedAt: s.updatedAt,
                createdAt: s.createdAt
                // Exclude 'config' which is encrypted/secret
            }));
            res.json({ sources: safeSources });
        } catch (e) {
            sendError(res, e);
        }
    });

    /**
     * POST /admin/users/:userId/sources
     * Create or Update a source config for a user.
     * Encrypts configuration at rest.
     */
    app.post("/admin/users/:userId/sources", requireAdmin, validateBody(CreateSourceSchema), async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { userId } = req.params;
            if (!userId) throw new AppError(400, "BAD_REQUEST", "UserId required");
            const { type, config, status } = req.body as { type: string; config: string; status: string };

            // Parse config if it resembles JSON, otherwise treat as string value
            let parsedConfig: unknown = config;
            try {
                if (config.trim().startsWith("{") || config.trim().startsWith("[")) {
                    parsedConfig = JSON.parse(config);
                }
            } catch {
                // Keep as string
            }

            // Use Core Helper for Encryption
            const { setPersistedConfig } = await import("../../core/persisted_cfg");
            await setPersistedConfig(userId, type, parsedConfig, status as "enabled" | "disabled");

            res.json({ success: true, type });
        } catch (e) {
            sendError(res, e);
        }
    });

    /**
     * DELETE /admin/users/:userId/sources/:type
     * Remove a source config.
     */
    app.delete("/admin/users/:userId/sources/:type", requireAdmin, async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { userId, type } = req.params;
            if (!userId || !type) throw new AppError(400, "BAD_REQUEST", "UserId and Type required");

            const { deletePersistedConfig } = await import("../../core/persisted_cfg");
            await deletePersistedConfig(userId, type);

            res.json({ success: true });
        } catch (e) {
            sendError(res, e);
        }
    });


    /**
     * POST /admin/users/:userId/train
     * Trigger classifier training for a user.
     */
    app.post("/admin/users/:userId/train", requireAdmin, async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { userId } = req.params;
            if (!userId) throw new AppError(400, "BAD_REQUEST", "UserId required");

            const { trainUserClassifier } = await import("../../ops/maintenance");
            const model = await trainUserClassifier(userId, 30);

            if (model) {
                res.json({ success: true, version: model.version, updatedAt: model.updatedAt });
            } else {
                res.json({ success: false, message: "Training skipped (insufficient data)" });
            }
        } catch (e) {
            sendError(res, e);
        }
    });
}
