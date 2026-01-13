import { z } from "zod";

import { env } from "../../core/cfg";
import { vectorStore } from "../../core/db";
import { Memory } from "../../core/memory";
import { updateUserSummary } from "../../memory/user_summary";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import { AppError, sendError } from "../errors";
import {
    validateBody,
    validateParams,
    validateQuery,
} from "../middleware/validate";

const AddMemorySchema = z.object({
    content: z.string().min(1).max(100000),
    tags: z.array(z.string()).optional().default([]),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    userId: z.string().optional(),
    id: z.string().optional(),
    createdAt: z.number().int().optional(),
});

const IngestSchema = z.object({
    contentType: z.string().min(1),
    data: z.unknown(), // Can be any serializable data
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    config: z.record(z.string(), z.unknown()).optional().default({}),
    userId: z.string().optional(),
    id: z.string().optional(),
    createdAt: z.number().int().optional(),
});

const IngestUrlSchema = z.object({
    url: z.string().url(),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    config: z.record(z.string(), z.unknown()).optional().default({}),
    userId: z.string().optional(),
    id: z.string().optional(),
    createdAt: z.number().int().optional(),
});

const BatchAddSchema = z.object({
    items: z.array(z.object({
        content: z.string().min(1).max(100000),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
    })),
    userId: z.string().optional(),
});

const QueryMemorySchema = z.object({
    query: z.string().min(1),
    k: z.number().optional().default(8),
    filters: z
        .object({
            sector: z.string().optional(),
            minScore: z.number().optional(),
            userId: z.string().optional(),
            startTime: z.string().or(z.number()).optional(),
            endTime: z.string().or(z.number()).optional(),
        })
        .optional(),
});

const ReinforceSchema = z.object({
    boost: z.number().optional().default(0.1),
});

const UpdateMemorySchema = z.object({
    content: z.string().max(100000).optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    userId: z.string().optional(),
});

const ListMemorySchema = z.object({
    u: z.coerce.number().default(0), // offset
    l: z.coerce.number().min(1).max(1000).default(100), // limit
    sector: z.string().optional(),
    userId: z.string().optional(),
});

const IdParamsSchema = z.object({
    id: z.string().min(1),
});

import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

/**
 * Registers Memory Operations routes.
 * Includes Add, Ingest, Query, Reinforce, Update, List, Get, Delete.
 * @param app Express/Server app instance
 */
export function memoryRoutes(app: ServerApp) {
    /**
     * Helper to resolve the user context based on auth scope and request parameters.
     * Enforces tenant isolation for non-admin users.
     */
    const getEffectiveUserId = (req: AdvancedRequest, bodyUserId?: string): string | undefined => {
        const isAdmin = (req.user?.scopes || []).includes("admin:all");
        let userId = req.user?.id;

        if (isAdmin && bodyUserId) {
            userId = bodyUserId;
        } else if (!userId) {
            // Unauthenticated (Open Mode) or Fallback
            userId = bodyUserId;
        }

        return normalizeUserId(userId) ?? undefined;
    };

    /**
     * POST /memory/add
     * Adds a new memory to the HSG.
     */
    // Handlers extracted for clarity and potential testing
    const addMemoryHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const body = req.body as z.infer<typeof AddMemorySchema>;
            const { content, tags, metadata, userId: bodyUserId, id, createdAt } = body;

            const normalizedUid = getEffectiveUserId(req, bodyUserId);

            // Use Memory class which handles event emission and hydration
            const m = new Memory(normalizedUid);
            const item = await m.add(content, {
                tags,
                id,
                createdAt,
                ...metadata,
            });

            res.json(item);

            if (normalizedUid) {
                updateUserSummary(normalizedUid).catch((e) =>
                    logger.error("[mem] user summary update failed:", {
                        error: e,
                    }),
                );
            }
        } catch (e: unknown) {
            sendError(res, e);
        }
    };




    const addBatchHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const body = req.body as z.infer<typeof BatchAddSchema>;
            const { items, userId: bodyUserId } = body;
            const normalizedUid = getEffectiveUserId(req, bodyUserId);

            const m = new Memory(normalizedUid);
            const added = await m.addBatch(items, { userId: normalizedUid ?? undefined });

            // Filter out error entries to find successful additions
            const successful = added.filter((r) => r && !('error' in r));

            // Update user summary only when there are successful additions
            if (successful.length > 0) {
                await updateUserSummary(normalizedUid).catch((e) =>
                    logger.warn(`Failed to update user summary for ${normalizedUid}:`, e)
                );
            }

            res.json({ items: added });
        } catch (e: unknown) {
            sendError(res, e);
        }
    };

    const ingestHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const {
                contentType,
                data,
                metadata,
                config,
                userId: bodyUserId,
                id,
                createdAt,
            } = req.body as z.infer<typeof IngestSchema>;

            const normalizedUid = getEffectiveUserId(req, bodyUserId);

            if (typeof data !== "string" && !Buffer.isBuffer(data)) {
                return sendError(
                    res,
                    new AppError(
                        400,
                        "INVALID_PAYLOAD",
                        "Data must be a string or Buffer",
                    ),
                );
            }

            // Use Memory Facade
            const m = new Memory(normalizedUid);
            const result = await m.ingest({
                contentType,
                data,
                metadata,
                config,
                userId: normalizedUid ?? undefined,
                id,
                createdAt,
            });
            res.json(result);
        } catch (e: unknown) {
            sendError(
                res,
                new AppError(
                    500,
                    "INGEST_FAILED",
                    "Ingestion failed",
                    e instanceof Error ? e.message : String(e),
                ),
            );
        }
    };

    const ingestUrlHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const {
                url,
                metadata,
                config,
                userId: bodyUserId,
                id,
                createdAt,
            } = req.body as z.infer<typeof IngestUrlSchema>;

            const normalizedUid = getEffectiveUserId(req, bodyUserId);

            // Use Memory Facade
            const m = new Memory(normalizedUid);
            const result = await m.ingestUrl(url, {
                metadata,
                config,
                userId: normalizedUid ?? undefined,
                id,
                createdAt,
            });
            res.json(result);
        } catch (e: unknown) {
            sendError(
                res,
                new AppError(
                    500,
                    "URL_INGEST_FAILED",
                    "URL ingestion failed",
                    e instanceof Error ? e.message : String(e),
                ),
            );
        }
    };

    const queryMemoryHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const { query, k, filters } = req.body as z.infer<
                typeof QueryMemorySchema
            >;

            const normalizedUid = getEffectiveUserId(req, filters?.userId);

            const filter = {
                sectors: filters?.sector ? [filters.sector] : undefined,
                minSalience: filters?.minScore,
                userId: normalizedUid ?? undefined,
            };

            const m = new Memory(normalizedUid);
            const matches = await m.search(query, {
                ...filter,
                limit: k,
            });

            res.json({
                query,
                matches: matches.map((x) => ({
                    id: x.id,
                    content: x.content,
                    score: x.score,
                    sectors: x.sectors,
                    primarySector: x.primarySector,
                    path: x.path,
                    salience: x.salience,
                    lastSeenAt: x.lastSeenAt,
                    updatedAt: x.updatedAt,
                    decayLambda: x.decayLambda,
                    version: x.version,
                    segment: x.segment,
                    simhash: x.simhash,
                    generatedSummary: x.generatedSummary,
                })),
            });
        } catch (e: unknown) {
            logger.error("[query] error:", { error: e });
            sendError(res, e instanceof Error ? e : new Error(String(e)));
        }
    };

    const reinforceHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const { id } = req.params;
            const { boost } = req.body as z.infer<typeof ReinforceSchema>;

            const m = new Memory(req.user?.id);
            await m.reinforce(id, boost);

            res.json({ ok: true });
        } catch (e: unknown) {
            sendError(
                res,
                new AppError(
                    404,
                    "NOT_FOUND",
                    "Memory not found for reinforcement",
                ),
            );
        }
    };

    const updateMemoryHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const id = req.params.id;
            const body = req.body as z.infer<typeof UpdateMemorySchema>;
            const { content, tags, metadata, userId: bodyUserId } = body;

            if (!id)
                return sendError(
                    res,
                    new AppError(400, "MISSING_ID", "ID is required"),
                );

            const checkUserId = getEffectiveUserId(req, bodyUserId);

            const m = new Memory(checkUserId);
            // Verify existence AND ownership via Facade get()
            const existing = await m.get(id);

            if (!existing)
                return sendError(
                    res,
                    new AppError(404, "NOT_FOUND", "Memory not found"),
                );

            const result = await m.update(
                id,
                content,
                tags,
                metadata,
                checkUserId ?? undefined,
            );
            res.json(result);
        } catch (e: unknown) {
            sendError(res, e);
        }
    };

    const listMemoryHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            // zod validation ensures types
            const query = req.query as unknown as z.infer<
                typeof ListMemorySchema
            >;
            const { u, l, sector, userId: queryUserId } = query;

            // Determine effective user context
            const targetUserId = getEffectiveUserId(req, queryUserId);

            // Regular users can ONLY see their own data if API Key is set
            if (env.apiKey && !req.user?.id) {
                return sendError(
                    res,
                    new AppError(
                        401,
                        "UNAUTHORIZED",
                        "Authentication required",
                    ),
                );
            }

            // Use Memory class for consistent hydration/decryption
            const m = new Memory(targetUserId);
            // If admin and no user specified, we might want global list, but Memory class defaults to "system" or specific user.
            // We use hostList which supports the null/admin case better
            const items = await m.hostList(l, u, sector, targetUserId);

            res.json({ items });
        } catch (e: unknown) {
            sendError(res, e);
        }
    };

    const getMemoryHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const id = req.params.id;
            const isAdmin = (req.user?.scopes || []).includes("admin:all");
            const userId = isAdmin ? undefined : req.user?.id;

            // Use Memory class
            const m = new Memory(userId);
            const memory = await m.get(id);

            if (!memory)
                return sendError(
                    res,
                    new AppError(404, "NOT_FOUND", "Memory not found"),
                );

            // Hydration already done by Memory.get
            // Just need to attach vectors if needed, but the route didn't seem to request them in the previous code?
            // Actually previous code fetched vectors but didn't seem to use them in the response JSON explicitly
            // except for mapping sectors? The sectors are already in the memory item (if we assume consistency).
            // Retaining original behavior of fetching sectors from vectors to be safe, though strict MemoryItem might be enough.

            const vectors = await vectorStore.getVectorsById(id);
            const sectors = vectors.map((x: { sector: string }) => x.sector);

            res.json({
                ...memory,
                sectors, // augment with sectors found in vector store
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    };

    const deleteMemoryHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const id = req.params.id;
            const userId = getEffectiveUserId(req);

            const m = new Memory(userId);
            const existing = await m.get(id); // Verification
            if (!existing)
                return sendError(
                    res,
                    new AppError(404, "NOT_FOUND", "Memory not found"),
                );

            await m.delete(id);
            res.json({ ok: true });
        } catch (e: unknown) {
            sendError(res, e);
        }
    };

    const deleteAllMemoryHandler = async (
        req: AdvancedRequest,
        res: AdvancedResponse,
    ) => {
        try {
            const query = req.query as Record<string, string>;
            const userId = getEffectiveUserId(req, query.userId); // Returns null if admin + no userId, or specific userId

            const isAdmin = (req.user?.scopes || []).includes("admin:all");

            if (!userId && !isAdmin) {
                return sendError(
                    res,
                    new AppError(403, "FORBIDDEN", "Global wipe requires admin privileges"),
                );
            }

            const m = new Memory(userId); // userId is normalized (null for global admin wipe)

            let count = 0;
            if (!userId && isAdmin) {
                // Global Wipe
                await m.wipe();
                // Return 0 or undefined for count? wipe() is void. We can't easily get count for global wipe efficiently without pre-count.
                // Let's assume OK.
                count = await m.deleteAll(userId);
            }
            res.json({ ok: true, success: true, deleted: count, deletedCount: count });
        } catch (e: unknown) {
            sendError(res, e);
        }
    };

    /**
     * POST /memory/add
     * Adds a new memory to the HSG.
     */
    app.post("/memory/add", validateBody(AddMemorySchema), addMemoryHandler);

    /**
     * POST /memory/batch
     * Adds multiple memories.
     */
    app.post("/memory/batch", validateBody(BatchAddSchema), addBatchHandler);

    /**
     * POST /memory/ingest
     * Ingests a document from raw data.
     */
    app.post("/memory/ingest", validateBody(IngestSchema), ingestHandler);

    /**
     * POST /memory/ingest/url
     * Ingests content from a URL.
     */
    app.post(
        "/memory/ingest/url",
        validateBody(IngestUrlSchema),
        ingestUrlHandler,
    );

    /**
     * POST /memory/query
     * Queries memories based on semantic similarity and filters.
     */
    app.post(
        "/memory/query",
        validateBody(QueryMemorySchema),
        queryMemoryHandler,
    );

    /**
     * POST /memory/:id/reinforce
     * Reinforces a specific memory.
     */
    app.post(
        "/memory/:id/reinforce",
        validateParams(IdParamsSchema),
        validateBody(ReinforceSchema),
        reinforceHandler,
    );

    /**
     * PATCH /memory/:id
     * Updates an existing memory.
     */
    app.patch(
        "/memory/:id",
        validateParams(IdParamsSchema),
        validateBody(UpdateMemorySchema),
        updateMemoryHandler,
    );

    /**
     * GET /memory/all
     * Lists all memories with pagination and filtering.
     */
    app.get("/memory/all", validateQuery(ListMemorySchema), listMemoryHandler);

    /**
     * GET /memory/:id
     * Retrieves a single memory by ID.
     */
    app.get("/memory/:id", validateParams(IdParamsSchema), getMemoryHandler);

    /**
     * DELETE /memory/all
     * Deletes all memories for a user or global (admin only).
     */
    app.delete("/memory/all", deleteAllMemoryHandler);

    /**
     * DELETE /memory/:id
     * Deletes a memory by ID.
     */
    app.delete(
        "/memory/:id",
        validateParams(IdParamsSchema),
        deleteMemoryHandler,
    );
}
