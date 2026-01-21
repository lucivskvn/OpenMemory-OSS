
import { Elysia } from "elysia";
import { z } from "zod";
import { q, transaction } from "../../core/db"; // Import transaction here to avoid dynamic import issues if possible, or keep dynamic if cycle risk
import { AppError } from "../errors";
import { rateLimitPlugin } from "../middleware/rateLimit";
import { getUser } from "../middleware/auth";
import { toHex } from "../../utils";
import { logger } from "../../utils/logger";

// --- Schemas (Zod) ---
// Kept Zod for consistent business logic validation
const UserIdParamSchema = z.object({ userId: z.string() });
const CreateUserSchema = z.object({ userId: z.string().min(1), summary: z.string().optional() });
const CreateKeySchema = z.object({ role: z.enum(["user", "admin", "read_only"]).default("user"), note: z.string().optional(), expiresInDays: z.number().optional().default(0) });
const CreateSourceSchema = z.object({ type: z.string().min(1), config: z.string().min(1), status: z.enum(["enabled", "disabled"]).default("enabled") });
const ListUsersQuerySchema = z.object({ l: z.coerce.number().max(1000).default(100), u: z.coerce.number().default(0) });
const KeyHashParamSchema = z.object({ keyHash: z.string().min(1) });
const SourceParamSchema = z.object({ userId: z.string().min(1), type: z.string().min(1) });
const TrainParamSchema = z.object({ userId: z.string().min(1) });

// --- Export Helper ---
const handleExport = async ({ query, set }: { query: Record<string, any>; set: any }) => {
    const { getContextId } = await import("../../core/db");
    const userId = query.userId || null;

    const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            const writeJson = (type: string, data: unknown) => {
                controller.enqueue(encoder.encode(JSON.stringify({ type, data }) + "\n"));
            };

            try {
                // 1. Export Users (If userId is specified, only that user)
                if (userId) {
                    const fullUser = await q.getUser.get(userId);
                    if (fullUser) writeJson("user", fullUser);
                } else {
                    const users = await q.getActiveUsers.all();
                    for (const user of users) {
                        const fullUser = await q.getUser.get(user.userId);
                        writeJson("user", fullUser);
                    }
                }

                // 2. Export Configs
                const allKeys = userId ? await q.getApiKeysByUser.all(userId) : await q.getAllApiKeys.all();
                for (const k of allKeys) writeJson("api_key", k);

                const configs = await q.getSourceConfigsByUser.all(userId);
                for (const c of configs) writeJson("source_config", c);

                // 3. Export Memories (Chunked)
                let offset = 0;
                const limit = 1000;
                while (true) {
                    const chunk = await q.allMemStable.all(limit, offset, userId);
                    if (chunk.length === 0) break;
                    for (const mem of chunk) writeJson("memory", mem);
                    offset += chunk.length;
                    // Yield to event loop
                    await new Promise(r => setTimeout(r, 0));
                }

                // 4. Webhooks (Only filter if userId provided)
                const webhooks = await q.listWebhooks.all(userId || undefined) as any[];
                for (const wh of webhooks) writeJson("webhook", wh);

                controller.close();
            } catch (err) {
                logger.error("[ADMIN] Export failed:", { error: err });
                controller.error(err);
            }
        }
    });

    set.headers["Content-Type"] = "application/x-ndjson";
    set.headers["Content-Disposition"] = `attachment; filename="openmemory_export_${userId || 'full'}_${Date.now()}.jsonl"`;

    return stream;
};

// --- Admin Guard ---
const ensureAdmin = (ctx: any) => {
    const user = getUser(ctx);
    if (!user || !user.scopes?.includes("admin:all")) {
        ctx.set.status = 403;
        throw new AppError(403, "FORBIDDEN", "Admin access required");
    }
};

/**
 * Admin API Routes Plugin
 * Grouped under /admin
 */
export const adminRoutes = (app: Elysia) => app.group("/admin", (app) => {
    return app
        .guard({ beforeHandle: ensureAdmin }, (app) => {
            // Strict Rate Limit for Admin Actions
            // We stack another rate limiter? Or rely on global?
            // Admin actions are sensitive. Let's add a strict one for modifying actions.
            // We can apply specific limits to specific routes or the whole group.
            // Let's use a sub-group for mutating actions if we want stricter limits, or just apply it to all admin routes.
            // Applying to all admin routes:
            return app.use(rateLimitPlugin({ windowMs: 60000, max: 20, keyPrefix: "admin" }))

                // --- User Management ---

                .get("/users", async ({ query }) => {
                    const p = ListUsersQuerySchema.parse(query);
                    const users = await q.getUsers.all(p.l, p.u);
                    return { users };
                })

                .post("/users", async ({ body }) => {
                    const p = CreateUserSchema.parse(body);
                    await q.insUser.run(p.userId, p.summary || "", 0, Date.now(), Date.now());
                    return { success: true, userId: p.userId };
                })

                .delete("/users/:userId", async ({ params }) => {
                    const p = UserIdParamSchema.parse(params);
                    // Comprehensive cascade delete
                    await q.delUserCascade.run(p.userId);
                    return { success: true, userId: p.userId };
                })

                // --- API Key Management ---

                .get("/users/:userId/keys", async ({ params }) => {
                    const p = UserIdParamSchema.parse(params);
                    const keys = await q.getApiKeysByUser.all(p.userId);
                    return { keys };
                })

                .post("/users/:userId/keys", async ({ params, body }) => {
                    const p = UserIdParamSchema.parse(params);
                    const b = CreateKeySchema.parse(body);

                    const rawKey = `om_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
                    const keyHashBuffer = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
                    const keyHash = toHex(keyHashBuffer);
                    const expiresAt = b.expiresInDays > 0 ? Date.now() + (b.expiresInDays * 24 * 60 * 60 * 1000) : 0;

                    await q.insApiKey.run(keyHash, p.userId, b.role, b.note || null, Date.now(), Date.now(), expiresAt);
                    return { success: true, key: rawKey, note: b.note, expiresAt };
                })

                .delete("/keys/:keyHash", async ({ params }) => {
                    const p = KeyHashParamSchema.parse(params);
                    await q.delApiKey.run(p.keyHash);
                    return { success: true };
                })

                // --- Source/MCP Config ---

                .get("/users/:userId/sources", async ({ params }) => {
                    const p = UserIdParamSchema.parse(params);
                    const sources = await q.getSourceConfigsByUser.all(p.userId);
                    const safeSources = sources.map((s: any) => ({
                        userId: s.userId,
                        type: s.type,
                        status: s.status,
                        updatedAt: s.updatedAt,
                        createdAt: s.createdAt
                    }));
                    return { sources: safeSources };
                })

                .post("/users/:userId/sources", async ({ params, body }) => {
                    const p = UserIdParamSchema.parse(params);
                    const b = CreateSourceSchema.parse(body);

                    let parsedConfig: unknown = b.config;
                    try {
                        if (b.config.trim().startsWith("{") || b.config.trim().startsWith("[")) {
                            parsedConfig = JSON.parse(b.config);
                        }
                    } catch { /* keep as string */ }

                    const { setPersistedConfig } = await import("../../core/persisted_cfg");
                    await setPersistedConfig(p.userId, b.type, parsedConfig, b.status as "enabled" | "disabled");
                    return { success: true, type: b.type };
                })

                .delete("/users/:userId/sources/:type", async ({ params }) => {
                    // Manually parse since we have 2 params
                    const p = SourceParamSchema.parse(params);
                    const { deletePersistedConfig } = await import("../../core/persisted_cfg");
                    await deletePersistedConfig(p.userId, p.type);
                    return { success: true };
                })

                // --- Training ---

                .post("/users/:userId/train", async ({ params }) => {
                    const p = TrainParamSchema.parse(params);
                    const { trainUserClassifier } = await import("../../ops/maintenance");
                    const model = await trainUserClassifier(p.userId, 30);
                    if (model) {
                        return { success: true, version: model.version, updatedAt: model.updatedAt };
                    } else {
                        return { success: false, message: "Training skipped (insufficient data)" };
                    }
                })

                // --- Export / Import ---

                .get("/export", ({ query, set }) => handleExport({ query, set }))
                .post("/export", ({ query, body, set }) => {
                    const combined = { ...query, ...(body as any) };
                    return handleExport({ query: combined, set });
                })

                .post("/import", async ({ request, body }) => {
                    // Note: Body size limit is handled by Server Config (maxPayloadSize).
                    // If body is larger than default, server config must allow it.
                    // We can't easily change limit PER route in Bun/Elysia dynamic without global config usually?
                    // Actually Elysia supports `body` size limit in config.
                    // We assume global config is sufficient (env.maxPayloadSize).

                    const { env } = await import("../../core/cfg");
                    const clHeader = request.headers.get("content-length");
                    const contentLength = parseInt(clHeader || "0");

                    if (contentLength > (env.maxImportSize || 50 * 1024 * 1024)) {
                        throw new AppError(413, "PAYLOAD_TOO_LARGE", "Import payload too large");
                    }

                    if (!body) throw new AppError(400, "BAD_REQUEST", "Empty body");

                    let items: { type: string; data: any }[] = [];
                    const reviveBuffers = (key: string, value: any): any => {
                        if (value && value.type === "Buffer" && Array.isArray(value.data)) {
                            return Buffer.from(value.data);
                        }
                        return value;
                    };

                    // Parsing Logic
                    // Elysia might have already parsed JSON body if Content-Type is application/json
                    if (Array.isArray(body)) {
                        items = body;
                    } else if (typeof body === "string") {
                        try {
                            items = JSON.parse(body, reviveBuffers);
                        } catch {
                            items = body.split("\n").filter(l => l.trim().length > 0).map(l => {
                                try { return JSON.parse(l, reviveBuffers); } catch { return null; }
                            }).filter(Boolean) as any[];
                        }
                    } else if (typeof body === "object") {
                        // Check 'tables' legacy format
                        if ('tables' in body) {
                            const tables = (body as any).tables;
                            for (const [tbl, rows] of Object.entries(tables)) {
                                if (Array.isArray(rows)) {
                                    const typeMap: Record<string, string> = {
                                        users: 'user', memories: 'memory', api_keys: 'api_key', source_configs: 'source_config', webhooks: 'webhook'
                                    };
                                    const type = typeMap[tbl] || tbl;
                                    items.push(...rows.map((r: any) => ({ type, data: r })));
                                }
                            }
                        } else {
                            // Single object? or unexpected structure.
                            // If it's just { type: ..., data: ... }
                            if ('type' in body && 'data' in body) {
                                items = [body as any];
                            } else {
                                // Maybe it's NDJSON parsed as object? Unlikely unless custom parser.
                                // Treat as empty or error?
                                // Let's assume Valid JSON body matching expectation.
                            }
                        }
                    }

                    // Import Transaction
                    let stats = { imported: 0, errors: 0 };

                    await transaction.run(async () => {
                        for (const item of items) {
                            if (!item.type || !item.data) continue;
                            try {
                                const d = item.data;
                                if (item.type === "user") {
                                    await q.insUser.run(d.userId, d.summary || "", d.reflectionCount || 0, d.createdAt || Date.now(), Date.now());
                                } else if (item.type === "memory") {
                                    const toBuf = (v: any) => (v && v.type === 'Buffer') ? Buffer.from(v.data) : (v instanceof Buffer ? v : Buffer.alloc(0));
                                    await q.insMem.run(
                                        d.id, d.content, d.primarySector || "unknown", d.tags, d.metadata,
                                        d.userId, d.segment || 0, d.simhash, d.createdAt || Date.now(), Date.now(),
                                        d.lastSeenAt || Date.now(), d.salience || 0.5, d.decayLambda, d.version || 1,
                                        d.meanDim || 0, toBuf(d.meanVec), toBuf(d.compressedVec), d.feedbackScore || 0, d.generatedSummary
                                    );
                                } else if (item.type === "source_config") {
                                    await q.insSourceConfig.run(d.userId, d.type, d.config, d.status, d.createdAt, Date.now());
                                } else if (item.type === "api_key") {
                                    await q.insApiKey.run(d.keyHash, d.userId, d.role, d.note, d.createdAt, d.lastUsedAt, d.expiresAt);
                                } else if (item.type === "webhook") {
                                    const { TABLES, upsertAsync } = await import("../../core/db");
                                    await upsertAsync(TABLES.webhooks, ["id"], {
                                        id: d.id, user_id: d.user_id, url: d.url, events: d.events, secret: d.secret,
                                        created_at: d.created_at || Date.now(), updated_at: d.updated_at || Date.now()
                                    });
                                }
                                stats.imported++;
                            } catch (e) {
                                stats.errors++;
                                logger.warn(`[IMPORT] Failed to import ${item.type}:`, { error: e });
                            }
                        }
                    });

                    return { success: true, stats };
                })
        });
});

