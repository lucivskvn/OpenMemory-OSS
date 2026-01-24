/**
 * Memory Facade for OpenMemory.
 * Provides a high-level API for managing memories, temporal graphs, and source ingestion.
 * 
 * @audited 2026-01-21
 */
import * as crypto from "crypto";
import {
    addHsgMemory,
    addHsgMemories,
    hsgQuery,
    reinforceMemory,
    updateMemory,
} from "../memory/hsg";
import { compressionEngine } from "../ops/compress";
import { ingestDocument, ingestUrl } from "../ops/ingest";
import { BaseSource } from "../sources/base";
import * as t_query from "../temporal_graph/query";
import * as t_store from "../temporal_graph/store";
import * as t_timeline from "../temporal_graph/timeline";
import { normalizeUserId, parseJSON, toBase64 } from "../utils";
import { SimpleCache } from "../utils/cache";
import { logger } from "../utils/logger";
import { env } from "./cfg";
import { q, transaction, vectorStore } from "./db";
import { eventBus, EVENTS } from "./events";
import { getContext } from "./context";
import { getEncryption } from "./security";
import {
    IngestRequest,
    IngestUrlRequest,
    IngestionConfig,
    MemoryItem,
    MemoryRow,
    TemporalAccess,
} from "./types";

/**
 * Options for memory operations, standardized to camelCase.
 */
export interface MemoryOptions {
    userId?: string | null;
    tags?: string[];
    metadata?: Record<string, unknown>;
    id?: string;
    createdAt?: number;
    [key: string]: unknown;
}

/**
 * Parses a raw database row into a hydrated MemoryItem.
 * Handles decryption and JSON parsing.
 */
export const parseMemory = async (row: MemoryRow): Promise<MemoryItem> => {
    const enc = getEncryption();
    // Destructure to exclude binary fields from the result
    const { meanVec: _mv, compressedVec: _cv, ...rest } = row;

    return {
        ...rest,
        content: await enc.decrypt(row.content),
        // Optimized: row already contains parsed objects from db_access.ts mapRow
        tags: Array.isArray(row.tags) ? row.tags : [],
        metadata: (typeof row.metadata === "object" && row.metadata !== null) ? row.metadata : {},
        compressedVecStr: row.compressedVec
            ? toBase64(new Uint8Array(row.compressedVec))
            : undefined,
    };
};

/**
 * Module-level cache for Memory items.
 * Key: Memory ID, Value: MemoryItem
 */
const memCache = new SimpleCache<string, MemoryItem>({
    maxSize: 2000,
    ttlMs: 5 * 60 * 1000, // 5 minutes
});

/**
 * Main facade for Memory operations in the OpenMemory SDK.
 * @public
 */
export class Memory {
    defaultUserId: string | null | undefined;

    constructor(userId?: string | null) {
        this.defaultUserId = normalizeUserId(userId);
    }

    /**
     * Add a new memory with automated classification and embedding.
     * 
     * **Integrity**: This operation is atomic within the HSG module.
     * **Sustainability**: Uses automated classification to reduce manual tagging overhead.
     * 
     * @param content The raw text content of the memory.
     * @param opts Configuration options (userId, tags, metadata).
     * @throws Error if content is empty or invalid.
     * @returns The fully hydrated and stored MemoryItem.
     */
    async add(content: string, opts?: MemoryOptions) {
        if (!content || content.trim().length === 0) {
            throw new Error("Memory content cannot be empty.");
        }
        if (content.length > env.maxPayloadSize) {
            throw new Error(
                `Memory content too large (${(content.length / 1024 / 1024).toFixed(2)}MB). Limit is ${(env.maxPayloadSize / 1024 / 1024).toFixed(2)}MB. Use 'ingest' for larger documents.`,
            );
        }
        if (opts?.tags && (!Array.isArray(opts.tags) || !opts.tags.every(t => typeof t === 'string'))) {
            throw new Error("Tags must be an array of strings.");
        }

        const { userId, tags = [], id, createdAt, metadata: metaInOpts, ...extra } = opts || {};
        const normalizedUserId = getUid(userId, this.defaultUserId);

        // Ensure we don't carry over known keys into metadata if they were in opts
        const metadata: Record<string, unknown> = { ...extra, ...(metaInOpts || {}) };

        const tagsStr = JSON.stringify(tags);

        // addHsgMemory now returns a full MemoryItem
        const item = await addHsgMemory(
            content,
            tagsStr,
            metadata,
            normalizedUserId,
            { id: id as string, createdAt: createdAt as number },
        );

        // Audit Log
        try {
            const ctx = getContext();
            q.auditLog.run({
                id: crypto.randomUUID(),
                userId: normalizedUserId || null,
                action: "memory.create",
                resourceType: "memory",
                resourceId: item.id,
                ipAddress: ctx?.ip || null,
                userAgent: ctx?.userAgent || null,
                // Redact metadata for audit log safety
                metadata: { primarySector: item.primarySector },
                timestamp: Date.now()
            }).catch((e: unknown) => logger.error("[Audit] Log failed", { error: e }));
        } catch { }

        return item;
    }

    /**
     * Batch add memories.
     * Supports concurrency control and per-item error reporting.
     * 
     * @param items List of memory contents and options.
     * @param opts.userId Optional user override.
     * @param opts.concurrency Maximum parallel executions (default: 5).
     * @returns Array of MemoryItem objects. If an item fails, it will contain an 'error' property.
     */
    async addBatch(
        items: Array<{ content: string; tags?: string[]; metadata?: Record<string, unknown> }>,
        opts?: { userId?: string | null; concurrency?: number }
    ): Promise<Array<MemoryItem & { error?: string }>> {
        if (!items.length) return [];
        const userId = getUid(opts?.userId, this.defaultUserId);
        const concurrency = opts?.concurrency || 5;

        // If no concurrency control is needed and we are in a high-performance environment,
        // we could use addHsgMemories for a fast path. 
        // However, the current test suite expects per-item error handling and validation.

        const results: Array<MemoryItem & { error?: string }> = new Array(items.length);
        const queue = [...items.keys()];

        const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (queue.length > 0) {
                const idx = queue.shift()!;
                const item = items[idx];
                try {
                    // Validation (as expected by tests)
                    if (item.tags && (!Array.isArray(item.tags) || !item.tags.every(t => typeof t === 'string'))) {
                        throw new Error("Tags must be an array of strings.");
                    }

                    results[idx] = await this.add(item.content, {
                        userId,
                        tags: item.tags,
                        metadata: item.metadata
                    });
                } catch (e: any) {
                    results[idx] = {
                        content: item.content,
                        error: e.message
                    } as any;
                }
            }
        });

        await Promise.all(workers);
        return results;
    }

    /**
     * Batch update multiple memories with distinct values.
     * @param items List of updates (id + changes).
     */
    async updateBatchItems(items: Array<{ id: string; content?: string; tags?: string[]; metadata?: Record<string, unknown> }>, userId?: string | null): Promise<Array<{ id: string; success: boolean; error?: string }>> {
        const uid = getUid(userId, this.defaultUserId);
        const results: Array<{ id: string; success: boolean; error?: string }> = [];

        for (const item of items) {
            try {
                const res = await this.update(item.id, {
                    content: item.content,
                    tags: item.tags,
                    metadata: item.metadata,
                    userId: uid
                });
                results.push({ id: item.id, success: res.ok });
            } catch (e: any) {
                results.push({ id: item.id, success: false, error: e.message });
            }
        }
        return results;
    }


    /**
     * Ingest a document from raw data (Text, Binary, etc).
     * @param opts.contentType MIME type of the data (e.g. application/pdf, text/markdown).
     * @param opts.data The raw data as string or Buffer.
     * @param opts.metadata Optional metadata to attach to the ingested memory.
     * @param opts.config Ingestion configuration (chunk size, etc).
     * @returns IngestionResult containing root ID and stats.
     */
    async ingest(opts: IngestRequest & { id?: string; createdAt?: number }) {
        const userId = getUid(opts.userId, this.defaultUserId);
        const data = opts.data;
        const metadata = { ...opts.metadata };
        if (opts.source) {
            metadata.source = opts.source;
        }

        return await ingestDocument(
            opts.contentType,
            data,
            {
                metadata,
                tags: opts.tags,
                config: opts.config,
                userId: userId ?? undefined,
                id: opts.id,
                createdAt: opts.createdAt,
            },
        );
    }

    /**
     * Alias for ingest() for better naming.
     */
    async ingestDocument(contentType: string, content: string | Buffer, opts?: { tags?: string[]; metadata?: Record<string, unknown>; config?: IngestionConfig; userId?: string | null }) {
        return await this.ingest({
            contentType,
            data: content,
            ...opts,
        } as IngestRequest);
    }

    /**
     * Ingest content from a public URL.
     * Fetches the content, extracts text/metadata, and stores it.
     * @param url The URL to ingest.
     * @param opts.metadata Optional metadata override.
     * @returns IngestionResult
     */
    async ingestUrl(url: string, opts?: Omit<IngestUrlRequest, "url"> & { id?: string; createdAt?: number }) {
        const userId = getUid(opts?.userId, this.defaultUserId);
        return await ingestUrl(
            url,
            {
                metadata: opts?.metadata,
                tags: opts?.tags,
                config: opts?.config,
                userId: userId ?? undefined,
                id: opts?.id,
                createdAt: opts?.createdAt,
            },
        );
    }

    /**
     * Reinforce a memory (increase its salience).
     * Useful for user feedback (thumbs up) or marking importance.
     * @param id The ID of the memory to reinforce.
     * @param boost Amount to add to salience (default: 0.1).
     * @param userId Optional user ID override.
     */
    async reinforce(id: string, boost?: number, userId?: string | null) {
        const uid = getUid(userId, this.defaultUserId);
        await reinforceMemory(id, boost, uid);
        this.invalidateCache(id);
        return { success: true };
    }

    /**
     * Update a memory by ID.
     * @param id The ID of the memory to update.
     * @param updates Object containing fields to update.
     */
    async update(
        id: string,
        updates: {
            content?: string;
            tags?: string[];
            metadata?: Record<string, any>;
            userId?: string | null;
        },
    ): Promise<{ id: string; ok: boolean }> {
        const uid = getUid(updates.userId, this.defaultUserId);
        const res = await updateMemory(id, { ...updates, userId: uid });

        if (!res) {
            throw new Error(`Memory not found: ${id}`);
        }

        // Audit Log
        const ctx = getContext();
        try {
            q.auditLog.run({
                id: crypto.randomUUID(),
                userId: uid || null,
                action: "memory.update",
                resourceType: "memory",
                resourceId: id,
                ipAddress: ctx?.ip || null,
                userAgent: ctx?.userAgent || null,
                metadata: { update: updates.content ? "content" : "meta" },
                timestamp: Date.now(),
            }).catch((e: unknown) => logger.error("[Audit] Log failed", { error: e }));
        } catch {
            // Context might not always be available in all runners
        }

        this.invalidateCache(id);
        eventBus.emit(EVENTS.MEMORY_UPDATED, { id, ...updates });

        return { id: res.id, ok: true };
    }

    /**
     * Retrieve a memory by ID.
     */
    async get(
        id: string,
        userId?: string | null,
    ): Promise<MemoryItem | undefined> {
        // Ensure database is initialized
        const { waitReady } = await import("./db");
        await waitReady();
        
        const uid = getUid(userId, this.defaultUserId);

        const cached = memCache.get(id);
        if (cached) {
            // Integrity: Ensure cached item belongs to the requested user context
            // Strict check: if uid is null (public), cached item MUST be public (userId===null)
            // if uid is "user", cached item MUST match "user"
            // The previous check (!uid) allowed access if uid was undefined (global), which is now prevented by new getUid, but we should be strict.
            if (cached.userId === uid) {
                return cached;
            }
        }

        const row = await q.getMem.get(id, uid);
        if (row) {
            const item = await parseMemory(row);
            memCache.set(id, item);
            return item;
        }
        return undefined;
    }

    /**
     * Delete multiple memories by ID.
     * @param ids - Array of memory IDs to delete.
     * @param userId - Optional user ID override.
     */
    async deleteBatch(ids: string[], userId?: string | null) {
        if (!ids || ids.length === 0) return 0;
        const uid = getUid(userId, this.defaultUserId);
        const res = await q.delMems.run(ids, uid);
        if (res > 0) {
            for (const id of ids) this.invalidateCache(id);
            // We skip individual event emission for large batches to avoid event loop pressure,
            // but we could emit a 'bulk_deleted' event if needed.
            // For now, keep it simple.
        }
        return res;
    }

    /**
     * Update multiple memories with the same content, tags, or metadata.
     * @param ids - Array of memory IDs to update.
     * @param updates - Object containing content, tags, or metadata to set.
     * @param userId - Optional user ID override.
     */
    async updateBatch(ids: string[], updates: { content?: string; tags?: string[]; metadata?: Record<string, unknown> }, userId?: string | null) {
        if (!ids || ids.length === 0) return 0;
        const uid = getUid(userId, this.defaultUserId);
        const res = await q.updMems.run(ids, updates, uid);
        if (res > 0) {
            for (const id of ids) this.invalidateCache(id);
        }
        return res;
    }

    /**
     * Delete a memory by ID.
     * @param id The ID of the memory to delete.
     * @param userId Optional user ID override.
     */
    async delete(id: string, userId?: string | null) {
        const uid = getUid(userId, this.defaultUserId);
        const item = await this.get(id, uid);
        const res = await q.delMem.run(id, uid);
        if (res > 0) {
            this.invalidateCache(id);
            if (item) eventBus.emit("memory_deleted", item);

            // Audit Log
            try {
                const ctx = getContext();
                q.auditLog.run({
                    id: crypto.randomUUID(),
                    userId: uid || null,
                    action: "memory.delete",
                    resourceType: "memory",
                    resourceId: id,
                    ipAddress: ctx?.ip || null,
                    userAgent: ctx?.userAgent || null,
                    metadata: null,
                    timestamp: Date.now()
                }).catch((e: unknown) => logger.error("[Audit] Log failed", { error: e }));
            } catch { }
        }
        return res;
    }

    /**
     * List all memories for the current default User Context with pagination.
     * To list for arbitrary users (admin), use `hostList`.
     */
    async list(limit = 100, offset = 0): Promise<MemoryItem[]> {
        const userId = this.defaultUserId;
        let rows: MemoryRow[];
        if (!userId) {
            rows = await q.allMem.all(limit, offset);
        } else {
            rows = await q.allMemByUser.all(userId, limit, offset);
        }
        return await Promise.all(rows.map(parseMemory));
    }

    /**
     * Multi-tenant list for admin/dashboard.
     */
    async hostList(
        limit = 100,
        offset = 0,
        sector?: string,
        userId?: string | null,
    ) {
        let rows: MemoryRow[];
        const uid = getUid(userId, this.defaultUserId);
        if (uid) {
            rows = await q.allMemByUser.all(uid, limit, offset);
        } else if (sector) {
            rows = await q.allMemBySector.all(sector, limit, offset);
        } else {
            rows = await q.allMem.all(limit, offset);
        }
        return await Promise.all(rows.map(parseMemory));
    }

    /**
     * Search memories using hybrid semantic and keyword retrieval.
     * @param query The search query string.
     * @param opts.userId Optional user ID to scope the search.
     * @param opts.limit Max number of results (default: 10).
     * @param opts.sectors List of sectors to filter by.
     * @param opts.minSalience Minimum salience threshold.
     * @returns Promise resolving to a list of HSG query results.
     */
    async search(
        query: string,
        opts?: {
            userId?: string | null;
            limit?: number;
            sectors?: string[];
            minSalience?: number;
        },
    ) {
        const limit = opts?.limit || 10;
        const userId = getUid(opts?.userId, this.defaultUserId);

        // Simplified filter construction to avoid syntax ambiguity
        const filter: { userId?: string; sectors?: string[]; minSalience?: number } = {};

        if (userId !== undefined) {
            filter.userId = userId as string;
        }
        if (opts?.sectors) {
            filter.sectors = opts.sectors;
        }
        if (opts?.minSalience) {
            filter.minSalience = opts.minSalience;
        }

        return await hsgQuery(query, limit, filter);
    }

    /**
     * Non-semantic filter for memories.
     * Supports filtering by sector, tags (any), or metadata key-value pairs.
     * 
     * @param filter.userId Optional user override.
     * @param filter.sector Primary sector to match exactly.
     * @param filter.tags Array of tags - matches if memory has ANY of these tags.
     * @param filter.metadata Key-value pairs to match in metadata JSON.
     * @param limit Max results (default 100).
     */
    async filter(
        filters: {
            userId?: string | null;
            sector?: string;
            tags?: string[];
            metadata?: Record<string, unknown>;
        },
        limit = 100,
        offset = 0
    ): Promise<MemoryItem[]> {
        const userId = getUid(filters.userId, this.defaultUserId);
        const rows = await q.findMems.all({
            ...filters,
            userId,
            limit,
            offset
        });
        return await Promise.all(rows.map(parseMemory));
    }

    /**
     * Updates memory statistics (lastSeen, salience) directly.
     * Useful for reflection and maintenance tasks where content doesn't change.
     */
    async updateStats(
        id: string,
        lastSeen?: number,
        salience?: number,
        timestamp?: number,
        userId?: string,
    ): Promise<boolean> {
        const uid = getUid(userId, this.defaultUserId);
        const ts = timestamp || Date.now();

        // Integrity: Fetch existing item to support partial updates without overwriting with null/0
        const item = await this.get(id, uid);
        if (!item) return false;

        const effectiveLastSeen = lastSeen !== undefined ? lastSeen : (item.lastSeenAt || ts);
        const effectiveSalience = salience !== undefined ? salience : (item.salience || 0.5);

        const success = await q.updSeen.run(
            id,
            effectiveLastSeen,
            effectiveSalience,
            ts,
            uid,
        );
        if (success) {
            this.invalidateCache(id);
        }
        return !!success;
    }

    /**
     * Delete all memories and the profile for a user.
     * Cascades to all associated data (vectors, graph, models).
     * @param userId The ID of the user to delete.
     * @returns Number of memories deleted.
     */
    async deleteUser(userId: string) {
        return await q.delUserCascade.run(userId);
    }

    /**
     * Wipes all content (memories, vectors, graph, models, webhooks) for a user
     * but preserves the user identity/profile.
     * 
     * **Integrity**: Ensures no orphaned data remains (Cascade Delete).
     * **Confidentiality**: Irreversibly destroys user data.
     * 
     * Process:
     * 1. Batched deletion of memories and associated vectors.
     * 2. Parallel deletion of Temporal Graph data (Facts, Edges).
     * 3. Deletion of learned models, configs, and webhooks.
     * 
     * @param userId The ID of the user to wipe content for.
     * @returns Promise resolving to the count of deleted memories.
     */
    async wipeUserContent(userId: string): Promise<number> {
        if (!userId) return 0;

        return await transaction.run(async () => {
            // 1. Batch delete vectors
            // Fail-Closed: If vector deletion fails, abort the wipe to prevent orphaned PII vectors.
            await vectorStore.deleteVectorsByUser(userId);

            // 2. Batch delete memories
            const deleted = await q.delMemByUser.run(userId);

            // 3. Cascade delete other user data

            // Delete webhooks and logs via efficient query
            await q.delWebhooksByUser.run(userId);

            await Promise.all([
                q.delFactsByUser.run(userId),
                q.delEdgesByUser.run(userId),
                q.delLearnedModel.run(userId),
                q.delSourceConfigsByUser.run(userId),
                q.delWaypointsByUser.run(userId),
                q.delEmbedLogsByUser.run(userId),
                q.delMaintLogsByUser.run(userId),
                q.delStatsByUser.run(userId),
            ]);

            logger.info(
                `[GDPR] Wiped content for user ${userId} (${deleted} memories)`,
            );

            // Audit
            try {
                const ctx = getContext();
                q.auditLog.run({
                    id: crypto.randomUUID(),
                    userId: userId,
                    action: "user.wipe",
                    resourceType: "user",
                    resourceId: userId,
                    ipAddress: ctx?.ip || null,
                    userAgent: ctx?.userAgent || null,
                    metadata: { deletedMemories: deleted },
                    timestamp: Date.now()
                }).catch((e: unknown) => logger.error("[Audit] Log failed", { error: e }));
            } catch { }

            return deleted;
        });
    }

    /**
     * Delete all memories for a user (Alias for wipeUserContent).
     */
    async deleteAll(userId?: string | null) {
        const uid = normalizeUserId(userId) || this.defaultUserId;
        if (uid) {
            return await this.wipeUserContent(uid);
        } else {
            logger.warn(
                "[Memory] deleteAll called without userId. Ignoring to prevent accidental global wipe.",
            );
        }
        return 0;
    }

    /**
     * Wipes the entire database. DESTRUCTIVE.
     */
    async wipe(): Promise<void> {
        await q.clearAll.run();
    }

    /**
     * List all unique user IDs.
     */
    /**
     * Lists all active user IDs in the system.
     * @returns Array of user ID strings.
     */
    async listUsers() {
        const res = await q.getActiveUsers.all();
        return res.map((u: { userId: string }) => u.userId);
    }

    /**
     * Invalidates the cache for a specific memory ID.
     */
    private invalidateCache(id: string) {
        memCache.delete(id);
    }




    private _temporal?: TemporalAccess;

    /**
     * Temporal Graph features.
     */
    get temporal(): TemporalAccess {
        if (!this._temporal) {
            this._temporal = {
                add: async (s: string, p: string, o: string, opts?: { confidence?: number; metadata?: Record<string, unknown> }) => {
                    const id = await t_store.insertFact(s, p, o, undefined, opts?.confidence, opts?.metadata, this.defaultUserId ?? undefined);
                    return id;
                },
                get: async (subject: string, predicate: string) => {
                    return await t_query.getCurrentFact(
                        subject,
                        predicate,
                        this.defaultUserId ?? undefined,
                    );
                },
                search: async (
                    pattern: string,
                    opts?: {
                        type?: "subject" | "predicate" | "object" | "all";
                        at?: Date;
                        limit?: number;
                    },
                ) => {
                    return await t_query.searchFacts(
                        pattern,
                        opts?.type || "all",
                        opts?.at,
                        opts?.limit || 10,
                        this.defaultUserId ?? undefined,
                    );
                },
                updateFact: async (
                    id: string,
                    confidence?: number,
                    metadata?: Record<string, unknown>,
                ) => {
                    await t_store.updateFact(
                        id,
                        this.defaultUserId ?? undefined,
                        confidence,
                        metadata,
                    );
                    return true;
                },
                invalidateFact: async (id: string, validTo?: Date) => {
                    await t_store.invalidateFact(id, this.defaultUserId ?? undefined, validTo);
                    return true;
                },
                invalidateEdge: async (id: string, validTo?: Date) => {
                    await t_store.invalidateEdge(id, this.defaultUserId ?? undefined, validTo);
                    return true;
                },
                updateEdge: async (id: string, weight?: number, metadata?: Record<string, unknown>) => {
                    await t_store.updateEdge(id, { weight, metadata }, this.defaultUserId ?? undefined);
                    return true;
                },
                queryFacts: async (
                    subject?: string,
                    predicate?: string,
                    object?: string,
                    at?: Date,
                    minConfidence = 0.5,
                ) => {
                    return await t_query.queryFactsAtTime(
                        subject,
                        predicate,
                        object,
                        at || new Date(),
                        minConfidence || 0.1,
                        this.defaultUserId ?? undefined,
                    );
                },
                getFactsBySubject: async (
                    subject: string,
                    at?: Date,
                    includeHistorical = false,
                    limit = 100,
                ) => {
                    return await t_query.getFactsBySubject(
                        subject,
                        at,
                        includeHistorical,
                        this.defaultUserId ?? undefined,
                        limit,
                    );
                },
                getPredicateHistory: async (
                    predicate: string,
                    from?: Date,
                    to?: Date,
                ) => {
                    return await t_timeline.getPredicateTimeline(
                        predicate,
                        from,
                        to,
                        this.defaultUserId ?? undefined,
                    );
                },
                timeline: async (
                    subject: string,
                    predicate?: string,
                    includeHistorical = true,
                ) => {
                    return await t_timeline.getSubjectTimeline(
                        subject,
                        predicate,
                        this.defaultUserId ?? undefined,
                    );
                },
                history: async (
                    subject: string,
                    predicate?: string,
                    includeHistorical = true,
                ) => {
                    return await t_timeline.getSubjectTimeline(
                        subject,
                        predicate,
                        this.defaultUserId ?? undefined,
                    );
                },
                addEdge: async (
                    sourceId: string,
                    targetId: string,
                    relationType: string,
                    opts?: {
                        weight?: number;
                        validFrom?: Date;
                        metadata?: Record<string, unknown>;
                    },
                ) => {
                    return await t_store.insertEdge(
                        sourceId,
                        targetId,
                        relationType,
                        opts?.validFrom,
                        opts?.weight,
                        opts?.metadata,
                        this.defaultUserId ?? undefined,
                    );
                },
                getEdges: async (
                    sourceId?: string,
                    targetId?: string,
                    relationType?: string,
                    at?: Date,
                    limit = 100,
                    offset = 0,
                ) => {
                    return await t_query.queryEdges(
                        sourceId,
                        targetId,
                        relationType,
                        at,
                        this.defaultUserId ?? undefined,
                        limit,
                        offset,
                    );
                },
                compare: async (subject: string, t1: Date, t2: Date) => {
                    const res = await t_timeline.compareTimePoints(
                        subject,
                        t1,
                        t2,
                        this.defaultUserId ?? undefined,
                    );
                    return {
                        subject,
                        time1: t1.toISOString(),
                        time2: t2.toISOString(),
                        added: res.added,
                        removed: res.removed,
                        unchanged: res.unchanged,
                        changed: res.changed.map(c => ({
                            predicate: c.before.predicate,
                            old: c.before,
                            new: c.after
                        })),
                        summary: {
                            added: res.added.length,
                            removed: res.removed.length,
                            changed: res.changed.length,
                            unchanged: res.unchanged.length
                        }
                    };
                },
                stats: async () => {
                    const userId = this.defaultUserId ?? undefined;
                    const [factCount, activeFactCount, edgeCount, activeEdgeCount] =
                        await Promise.all([
                            t_store.getTotalFactsCount(userId),
                            t_store.getActiveFactsCount(userId),
                            t_store.getTotalEdgesCount(userId),
                            t_store.getActiveEdgesCount(userId),
                        ]);
                    return {
                        facts: { total: factCount, active: activeFactCount },
                        edges: { total: edgeCount, active: activeEdgeCount },
                    };
                },
                decay: async (decayRate?: number) => {
                    return await t_store.applyConfidenceDecay(
                        decayRate,
                        this.defaultUserId ?? undefined,
                    );
                },
                getGraphContext: async (
                    factId: string,
                    opts?: { relationType?: string; at?: Date },
                ) => {
                    return await t_query.getRelatedFacts(
                        factId,
                        opts?.relationType,
                        opts?.at,
                        this.defaultUserId ?? undefined,
                    );
                },
                volatile: async (subject?: string, limit = 10) => {
                    const res = await t_timeline.getVolatileFacts(
                        subject,
                        limit,
                        this.defaultUserId ?? undefined,
                    );
                    return {
                        limit,
                        volatileFacts: res,
                        count: res.length
                    };
                },
            };
        }
        return this._temporal!;
    }

    /**
     * Compression Engine features.
     */
    get compression() {
        return {
            compress: (
                text: string,
                algorithm?: "semantic" | "syntactic" | "aggressive",
            ) => {
                return compressionEngine.compress(text, algorithm);
            },
            batch: (
                texts: string[],
                algorithm?: "semantic" | "syntactic" | "aggressive",
            ) => {
                return compressionEngine.batch(texts, algorithm);
            },
            analyze: (text: string) => {
                return compressionEngine.analyze(text);
            },
            stats: () => {
                return compressionEngine.getStats();
            },
            reset: () => {
                compressionEngine.resetStats();
                compressionEngine.clearCache();
            },
        };
    }

    /**
     * Load a source connector by name.
     */
    async source(name: string): Promise<BaseSource<unknown, unknown>> {
        const sources: Record<string, () => Promise<BaseSource<unknown, unknown>>> = {
            github: () => import("../sources/github").then((m) => new m.GithubSource(this.defaultUserId ?? undefined)),
            notion: () => import("../sources/notion").then((m) => new m.NotionSource(this.defaultUserId ?? undefined)),
            google_drive: () => import("../sources/googleDrive").then((m) => new m.GoogleDriveSource(this.defaultUserId ?? undefined)),
            google_sheets: () => import("../sources/googleSheets").then((m) => new m.GoogleSheetsSource(this.defaultUserId ?? undefined)),
            google_slides: () => import("../sources/googleSlides").then((m) => new m.GoogleSlidesSource(this.defaultUserId ?? undefined)),
            onedrive: () => import("../sources/onedrive").then((m) => new m.OneDriveSource(this.defaultUserId ?? undefined)),
            web_crawler: () => import("../sources/webCrawler").then((m) => new m.WebCrawlerSource(this.defaultUserId ?? undefined)),
        };

        if (!(name in sources)) {
            throw new Error(`unknown source: ${name}`);
        }

        return await sources[name]();
    }

    /**
     * Get system statistics including memory counts, vector counts, and temporal graph stats.
     */
    async stats(): Promise<{ memories: number; vectors: number; facts: number; relations: number }> {
        const uid = this.defaultUserId;
        
        // Ensure database is initialized
        const { waitReady, q } = await import("./db");
        await waitReady();
        
        // Get memory and vector counts
        const memoryStats = await q.getStats.get(uid);
        const vectorCount = await q.getVecCount.get(uid);
        
        // Get temporal graph stats
        const factCount = await q.getFactCount?.get?.(uid) || { c: 0 };
        const edgeCount = await q.getEdgeCount?.get?.(uid) || { c: 0 };
        
        return {
            memories: memoryStats?.count || 0,
            vectors: vectorCount?.c || 0,
            facts: factCount?.c || 0,
            relations: edgeCount?.c || 0
        };
    }
}

/**
 * Normalizes userId for the current context.
 */
const getUid = (userId: string | null | undefined, defaultId: string | null | undefined): string | null => {
    // 1. If userId is provided as a string, normalize it. If it's undefined, it's NOT provided.
    // normalizeUserId returns null for "anonymous" etc., and undefined for "system"
    const normalizedIn = userId !== undefined ? normalizeUserId(userId) : undefined;

    // 2. If it wasn't provided (undefined), use the normalized defaultId.
    const defaultNormalized = normalizeUserId(defaultId);

    // 3. Priorities: Explicit > Default > null (anonymous)
    const final = normalizedIn !== undefined ? normalizedIn : defaultNormalized;

    return final === undefined ? null : final;
};
