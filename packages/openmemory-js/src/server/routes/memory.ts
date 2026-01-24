import { Elysia } from "elysia";
import { z } from "zod";
import { MAX_CONTENT_LENGTH } from "../../ai/schemas";

import { env } from "../../core/cfg";
import { vectorStore } from "../../core/db";
import { Memory } from "../../core/memory";
import { UserContext } from "../../core/types";
import { updateUserSummary } from "../../memory/userSummary";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";
import { verifyUserAccess, getUser, getEffectiveUserId } from "../middleware/auth";
import {
    ContentValidationSchema,
    MetadataValidationSchema,
    TagsValidationSchema,
    UserIdValidationSchema,
    createInputValidator,
} from "../../utils/inputSanitization";

// --- Enhanced Schemas with Security Validation ---

const AddMemorySchema = z.object({
    content: ContentValidationSchema,
    tags: TagsValidationSchema,
    metadata: MetadataValidationSchema,
    userId: UserIdValidationSchema.optional(),
    id: z.string().optional(),
    createdAt: z.number().int().optional(),
});

const IngestSchema = z.object({
    contentType: z.string().min(1).max(100),
    data: z.unknown(), // Can be any serializable data
    metadata: MetadataValidationSchema,
    config: z.record(z.string(), z.unknown()).optional().default({}),
    userId: UserIdValidationSchema.optional(),
    id: z.string().optional(),
    createdAt: z.number().int().optional(),
    source: z.string().max(255).optional(),
});

const IngestUrlSchema = z.object({
    url: z.string().url().max(2048),
    metadata: MetadataValidationSchema,
    config: z.record(z.string(), z.unknown()).optional().default({}),
    userId: UserIdValidationSchema.optional(),
    id: z.string().optional(),
    createdAt: z.number().int().optional(),
});

const BatchAddSchema = z.object({
    items: z.array(z.object({
        content: ContentValidationSchema,
        tags: TagsValidationSchema.optional(),
        metadata: MetadataValidationSchema.optional(),
    })),
    userId: z.string().optional(),
});

const QueryMemorySchema = z.object({
    query: z.string().min(1),
    k: z.number().max(100).optional().default(8),
    filters: z
        .object({
            sector: z.string().optional(),
            minScore: z.number().optional(),
            userId: z.string().optional(),
            startTime: z.coerce.number().optional(),
            endTime: z.coerce.number().optional(),
        })
        .optional(),
});

const BatchDeleteSchema = z.object({
    ids: z.array(z.string().min(1)).min(1),
});

const BatchUpdateSchema = z.object({
    items: z.array(z.object({
        id: z.string().min(1),
        content: z.string().max(MAX_CONTENT_LENGTH).optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
    })),
    userId: z.string().optional(),
});

const ReinforceSchema = z.object({
    boost: z.number().optional().default(0.1),
});

const UpdateMemorySchema = z.object({
    content: z.string().max(MAX_CONTENT_LENGTH).optional(),
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

/**
 * Registers Memory Operations routes.
 * Includes Add, Ingest, Query, Reinforce, Update, List, Get, Delete.
 */
export const memoryRoutes = (app: Elysia) => app.group("/memory", (app) => {
    return app
        /**
         * POST /memory/add
         * Adds a new memory to the HSG.
         */
        .post("/add", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = AddMemorySchema.parse(body);
            const normalizedUid = getEffectiveUserId(user, b.userId);

            const m = new Memory(normalizedUid);
            const item = await m.add(b.content, {
                ...b.metadata,
                tags: b.tags,  // Ensure tags from body take precedence over metadata
                id: b.id,
                createdAt: b.createdAt,
            });

            if (normalizedUid) {
                // Async update
                updateUserSummary(normalizedUid).catch((e) =>
                    logger.error("[mem] user summary update failed:", { error: e })
                );
            }
            return item;
        })

        /**
         * POST /memory/batch
         * Adds multiple memories.
         */
        .post("/batch", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = BatchAddSchema.parse(body);
            const normalizedUid = getEffectiveUserId(user, b.userId);

            const m = new Memory(normalizedUid);
            const added = await m.addBatch(b.items, { userId: normalizedUid ?? undefined });

            // Check for successful adds
            const successful = added.filter((r) => r && !('error' in r));
            if (successful.length > 0 && normalizedUid) {
                updateUserSummary(normalizedUid).catch((e) =>
                    logger.warn(`Failed to update user summary for ${normalizedUid}:`, e)
                );
            }

            return { items: added };
        })

        /**
         * PATCH /memory/batch
         * Batch updates multiple memories.
         */
        .patch("/batch", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = BatchUpdateSchema.parse(body);
            const normalizedUid = getEffectiveUserId(user, b.userId);

            const m = new Memory(normalizedUid);
            const results = await m.updateBatchItems(b.items, normalizedUid ?? undefined);

            return { items: results };
        })

        /**
         * POST /memory/ingest
         * Ingests a document from raw data.
         */
        .post("/ingest", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = IngestSchema.parse(body);
            const normalizedUid = getEffectiveUserId(user, b.userId);

            if (typeof b.data !== "string" && !Buffer.isBuffer(b.data) && !(b.data instanceof Uint8Array)) {
                throw new AppError(400, "INVALID_PAYLOAD", "Data must be a string, Buffer, or Uint8Array");
            }

            const m = new Memory(normalizedUid);
            const result = await m.ingest({
                source: "api",
                contentType: b.contentType,
                data: b.data as string | Buffer | Uint8Array,
                metadata: b.metadata,
                config: b.config,
                userId: normalizedUid ?? undefined,
                id: b.id,
                createdAt: b.createdAt,
            });
            return result;
        })

        /**
         * POST /memory/ingest/url
         * Ingests content from a URL.
         */
        .post("/ingest/url", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = IngestUrlSchema.parse(body);
            const normalizedUid = getEffectiveUserId(user, b.userId);

            const m = new Memory(normalizedUid);
            const result = await m.ingestUrl(b.url, {
                metadata: b.metadata,
                config: b.config,
                userId: normalizedUid ?? undefined,
                id: b.id,
                createdAt: b.createdAt,
            });
            return result;
        })

        /**
         * POST /memory/query
         * Queries memories based on semantic similarity and filters.
         */
        .post("/query", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = QueryMemorySchema.parse(body);
            const normalizedUid = getEffectiveUserId(user, b.filters?.userId);

            const filter = {
                sectors: b.filters?.sector ? [b.filters.sector] : undefined,
                minSalience: b.filters?.minScore,
                userId: normalizedUid ?? undefined,
                startTime: b.filters?.startTime,
                endTime: b.filters?.endTime,
            };

            const m = new Memory(normalizedUid);
            const matches = await m.search(b.query, {
                ...filter,
                limit: b.k,
            });

            return {
                success: true,
                query: b.query,
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
            };
        })

        /**
         * POST /memory/:id/reinforce
         * Reinforces a specific memory.
         */
        .post("/:id/reinforce", async ({ params, body, query, ...ctx }) => {
            const user = getUser(ctx);
            const p = IdParamsSchema.parse(params);
            const b = ReinforceSchema.parse(body);

            const normalizedUid = getEffectiveUserId(user, query.userId);
            const m = new Memory(normalizedUid);
            await m.reinforce(p.id, b.boost);

            return { success: true };
        })

        /**
         * PATCH /memory/:id
         * Updates an existing memory.
         */
        .patch("/:id", async ({ params, body, query, ...ctx }) => {
            const user = getUser(ctx);
            const p = IdParamsSchema.parse(params);
            const b = UpdateMemorySchema.parse(body);
            const normalizedUid = getEffectiveUserId(user, query.userId || b.userId);

            const m = new Memory(normalizedUid);
            const existing = await m.get(p.id);
            if (!existing) throw new AppError(404, "NOT_FOUND", "Memory not found");

            const result = await m.update(p.id, {
                content: b.content,
                tags: b.tags,
                metadata: b.metadata,
                userId: normalizedUid ?? undefined,
            });
            return result;
        })

        /**
         * GET /memory/all
         * Lists all memories with pagination and filtering.
         */
        .get("/all", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const qParams = ListMemorySchema.parse(query);
            const normalizedUid = getEffectiveUserId(user, qParams.userId); // explicit userId in query overrides context if allowed

            // Regular users can ONLY see their own data if API Key is set
            // (handled by getEffectiveUserId implicitly via verifyUserAccess, but verifyUserAccess allows mismatch for admin)
            // If user is not admin and tries to see global (null id)...
            // verifyUserAccess(user, null) -> returns null if allowed (i.e. user matches null?? No).

            // Re-evaluating verifyUserAccess logic in auth.ts:
            // if target is null ("me" -> auth), it becomes auth.
            // if target is explicit, checks match.
            // If target is undefined in getEffectiveUserId call:
            // normalizeUserId(undefined) -> null.
            // verifyUserAccess(u, null) ->
            //   if admin -> null ok.
            //   if not admin ->
            //      if !auth -> throw "auth required"
            //      if auth -> throw "access denied" (auth != null)
            // So non-admins CANNOT list global (all users). Correct.

            const m = new Memory(normalizedUid);
            const items = await m.hostList(qParams.l, qParams.u, qParams.sector, normalizedUid);
            return { items };
        })

        /**
         * GET /memory/:id
         * Retrieves a single memory by ID.
         */
        .get("/:id", async ({ params, query, ...ctx }) => {
            const user = getUser(ctx);
            const p = IdParamsSchema.parse(params);
            const userId = getEffectiveUserId(user, query.userId);
            const m = new Memory(userId);
            const memory = await m.get(p.id);

            if (!memory) throw new AppError(404, "NOT_FOUND", "Memory not found");

            // Additional vector/sector info not usually needed if MemoryItem has it, 
            // but preserving legacy behavior of fetching sectors from vector store if consistent.
            const vectors = await vectorStore.getVectorsById(p.id);
            const sectors = vectors.map((x) => x.sector);

            return { ...memory, sectors };
        })

        /**
         * DELETE /memory/all
         * Deletes all memories for a user or global (admin only).
         */
        .delete("/all", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const qParams = query as Record<string, string>;
            const userId = getEffectiveUserId(user, qParams.userId);

            const isAdmin = (user?.scopes || []).includes("admin:all");

            if (!userId && !isAdmin) {
                throw new AppError(403, "FORBIDDEN", "Global wipe requires admin privileges");
            }

            const m = new Memory(userId);
            let count = 0;
            if (!userId && isAdmin) {
                await m.wipe();
                count = 0; // Unknown count
            } else if (userId) {
                count = await m.deleteAll(userId);
            }

            return { success: true, deleted: count };
        })

        /**
         * POST /memory/batch/delete
         * Deletes multiple memories by ID.
         */
        .post("/batch/delete", async ({ body, query, ...ctx }) => {
            const b = BatchDeleteSchema.parse(body);
            const user = getUser(ctx);
            const normalizedUid = getEffectiveUserId(user, query.userId);

            const m = new Memory(normalizedUid);
            const count = await m.deleteBatch(b.ids, normalizedUid);

            return { success: true, count };
        })

        /**
         * DELETE /memory/:id
         * Deletes a memory by ID.
         */
        .delete("/:id", async ({ params, query, ...ctx }) => {
            const user = getUser(ctx);
            const userId = getEffectiveUserId(user, query.userId);
            const m = new Memory(userId);
            const memory = await m.get(params.id);
            if (!memory) throw new AppError(404, "NOT_FOUND", "Memory not found");

            await m.delete(params.id);
            return { success: true };
        });
});

// End of file
