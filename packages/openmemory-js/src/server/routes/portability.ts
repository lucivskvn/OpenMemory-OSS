import { q } from "../../core/db";
import { logger } from "../../utils/logger";
import { AppError, sendError } from "../errors";
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

/**
 * Data Portability Routes
 * Allows Admin to Export/Import the entire database state (or partial).
 * Crucial for SaaS data sovereignty ("Exit Strategy").
 */
export const portabilityRoutes = (app: ServerApp) => {
    /**
     * GET /admin/export
     * Streams a JSONL dump of the database.
     * Includes: Users, Memories, SourceConfigs, SystemStats (optional).
     */
    app.get(
        "/admin/export",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                // CRITICAL: Strict admin check
                if (!isAdmin)
                    return sendError(
                        res,
                        new AppError(403, "FORBIDDEN", "Admin access required"),
                    );

                // Optimized: Use ReadableStream for memory-efficient streaming
                const stream = new ReadableStream({
                    async start(controller) {
                        const encoder = new TextEncoder();
                        const writeJson = (type: string, data: unknown) => {
                            controller.enqueue(encoder.encode(JSON.stringify({ type, data }) + "\n"));
                        };

                        try {
                            // 1. Export Users
                            logger.info("[EXPORT] Starting User export...");
                            const users = await q.getActiveUsers.all();
                            for (const user of users) {
                                const fullUser = await q.getUser.get(user.userId);
                                writeJson("user", fullUser);
                            }

                            // 2. Export Configs
                            logger.info("[EXPORT] Starting Config export...");
                            const allKeys = await q.getAllApiKeys.all();
                            for (const k of allKeys) writeJson("api_key", k);

                            const configs = await q.getSourceConfigsByUser.all(null);
                            for (const c of configs) writeJson("source_config", c);

                            // 3. Export Memories (Chunked)
                            logger.info("[EXPORT] Starting Memory export...");
                            let offset = 0;
                            const limit = 1000;
                            while (true) {
                                const chunk = await q.allMemStable.all(limit, offset, null);
                                if (chunk.length === 0) break;

                                for (const mem of chunk) {
                                    writeJson("memory", mem);
                                }
                                offset += chunk.length;
                                // Yield to event loop to prevent blocking
                                await new Promise(r => setTimeout(r, 0));
                            }

                            logger.info("[EXPORT] Completed.");
                            controller.close();
                        } catch (err) {
                            logger.error("[EXPORT] Stream failed:", { error: err });
                            controller.error(err);
                        }
                    }
                });

                res.setHeader("Content-Type", "application/x-ndjson");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="openmemory_backup_${Date.now()}.jsonl"`,
                );
                // Return the stream directly as the body
                // NOTE: server.ts needs to handle ReadableStream body if it doesn't already.
                // Our server.ts checks for `bodyObjIsFile` or `ReadableStream`.
                // Let's verify `server.ts` handles this.
                // server.ts `agRes.send` checks `body instanceof Blob` or `bodyObjIsFile`.
                // `bodyObjIsFile` checks `body.constructor.name === "ReadableStream"`.
                // So passing the stream to `res.send(stream)` should work.

                res.send(stream);
            } catch (err: unknown) {
                logger.error("[EXPORT] Failed:", { error: err });
                if (!res.writableEnded) sendError(res, err);
            }
        },
    );

    /**
     * POST /admin/import
     * Accepts a JSONL file and restores the state.
     * Strategy: Upsert (Merge).
     */
    app.post(
        "/admin/import",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                if (!isAdmin)
                    return sendError(
                        res,
                        new AppError(403, "FORBIDDEN", "Admin access required"),
                    );

                // DoS Protection: Check Content-Length
                const clHeader = req.headers["content-length"];
                const contentLengthStr = Array.isArray(clHeader) ? clHeader[0] : clHeader || "0";
                const contentLength = parseInt(contentLengthStr);

                if (contentLength > 50 * 1024 * 1024) { // 50MB Limit
                    return sendError(
                        res,
                        new AppError(413, "PAYLOAD_TOO_LARGE", "Import payload exceeds 50MB limit"),
                    );
                }

                const body = req.body;
                let items: ImportItem[] = [];

                // Helper to hydrate Buffers from JSON
                const reviveBuffers = (key: string, value: any) => {
                    if (
                        value &&
                        value.type === "Buffer" &&
                        Array.isArray(value.data)
                    ) {
                        return Buffer.from(value.data);
                    }
                    return value;
                };

                // If body is already parsed by server framework as JSON (Object/Array) without reviver,
                // we need to traverse and fix buffers.
                // However, Bun server might not have used our reviver.
                // If body is string, we parse with reviver.
                // If body is object, we traverse.

                const hydrateDeep = (obj: any): any => {
                    if (obj === null || typeof obj !== "object") return obj;
                    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
                        return Buffer.from(obj.data);
                    }
                    if (Array.isArray(obj)) {
                        return obj.map(hydrateDeep);
                    }
                    for (const k in obj) {
                        obj[k] = hydrateDeep(obj[k]);
                    }
                    return obj;
                };

                if (Array.isArray(body)) {
                    items = hydrateDeep(body);
                } else if (typeof body === "string") {
                    // Try parsing line by line or full JSON
                    try {
                        const parsed = JSON.parse(body, reviveBuffers);
                        if (Array.isArray(parsed)) items = parsed;
                    } catch {
                        // Line-delimited JSON
                        items = body
                            .split("\n")
                            .filter((l) => l.trim().length > 0)
                            .map((l) => {
                                try {
                                    return JSON.parse(l, reviveBuffers);
                                } catch { return null; }
                            })
                            .filter(Boolean);
                    }
                } else if (typeof body === "object") {
                    items = [hydrateDeep(body)];
                }

                const result = await processImport(items);
                res.json(result);
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    interface ImportItem {
        type: string;
        data: Record<string, any>; // Complex data structure, hard to type strictly without major refactor
    }

    async function processImport(items: ImportItem[]) {
        const counts = { users: 0, memories: 0, configs: 0, errors: 0 };

        for (const item of items) {
            try {
                if (item.type === "user") {
                    const u = item.data;
                    await q.insUser.run(
                        u.userId,
                        u.summary || "",
                        u.reflectionCount || 0,
                        u.createdAt || Date.now(),
                        Date.now(),
                    );
                    counts.users++;
                } else if (item.type === "source_config") {
                    const c = item.data;
                    await q.insSourceConfig.run(
                        c.userId,
                        c.type,
                        c.config,
                        c.status || "enabled",
                        c.createdAt,
                        Date.now(),
                    );
                    counts.configs++;
                } else if (item.type === "memory") {
                    const m = item.data;
                    await q.insMem.run(
                        m.id,
                        m.content,
                        m.primarySector || "unknown",
                        m.tags || null,
                        m.metadata || null,
                        m.userId,
                        m.segment || 0,
                        m.simhash || null,
                        m.createdAt || Date.now(),
                        Date.now(),
                        m.lastSeenAt || Date.now(),
                        m.salience || 0.5,
                        m.decayLambda || 0.01,
                        m.version || 1,
                        m.meanDim || 0,
                        m.meanVec || Buffer.alloc(0), // Vectors might be lost in JSON unless base64, usually re-compute
                        m.compressedVec || Buffer.alloc(0),
                        m.feedbackScore || 0,
                        m.generatedSummary || null,
                    );
                    counts.memories++;
                }
            } catch (e) {
                // Unique constraint violations are "success" in merge mode if we assume we keep existing?
                // Or we update? insUser/insMem have ON CONFLICT UPDATE built-in in db.ts
                // So it should just work.
                logger.warn("[IMPORT] Item failed", { error: e });
                counts.errors++;
            }
        }

        return { success: true, ...counts };
    }
};
