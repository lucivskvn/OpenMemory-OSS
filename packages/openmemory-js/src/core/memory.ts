/**
 * Memory Facade for OpenMemory.
 * Provides a high-level API for managing memories, temporal graphs, and source ingestion.
 */
import {
    addHsgMemory,
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
import { logger } from "../utils/logger";
import { env } from "./cfg";
import { q, vectorStore } from "./db";
import { eventBus } from "./events";
import { getEncryption } from "./security";
import {
    IngestRequest,
    IngestUrlRequest,
    MemoryItem,
    MemoryRow,
} from "./types";

/**
 * Options for memory operations, standardized to camelCase.
 */
export interface MemoryOptions {
    userId?: string | null;
    tags?: string[];
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
        tags: row.tags ? parseJSON(row.tags) : [],
        metadata: row.metadata ? parseJSON(row.metadata) : {},
        compressedVecStr: row.compressedVec
            ? toBase64(row.compressedVec)
            : undefined,
    };
};

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
        const { userId, tags = [], id, createdAt, ...extra } = opts || {};
        const normalizedUserId = getUid(userId, this.defaultUserId);

        // Ensure we don't carry over known keys into metadata if they were in opts
        const metadata: Record<string, unknown> = { ...extra };

        const tagsStr = JSON.stringify(tags);

        // addHsgMemory handles internal logic and returns a simplified result
        const res = await addHsgMemory(
            content,
            tagsStr,
            metadata,
            normalizedUserId ?? undefined,
            { id: id as string, createdAt: createdAt as number },
        );
        const item = (await this.get(res.id, normalizedUserId))!;
        eventBus.emit("memory_added", item);
        return item;
    }

    /**
     * Batch add memories.
     * Currently iterates sequentially, but poised for batch optimization.
     * @param items List of memory contents and options.
     */
    async addBatch(items: Array<{ content: string; tags?: string[]; metadata?: Record<string, unknown> }>, opts?: { userId?: string | null }) {
        const results = [];
        for (const item of items) {
            try {
                const result = await this.add(item.content, {
                    ...item.metadata,
                    userId: opts?.userId,
                    tags: item.tags
                });
                results.push(result);
            } catch (error) {
                results.push({ error: error instanceof Error ? error.message : String(error) });
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
    async ingest(opts: Omit<IngestRequest, "source"> & { source?: string; id?: string; createdAt?: number }) {
        const userId = getUid(opts.userId, this.defaultUserId);
        const data =
            opts.data instanceof Uint8Array && !Buffer.isBuffer(opts.data)
                ? Buffer.from(opts.data)
                : (opts.data as string | Buffer);
        const metadata = { ...opts.metadata };
        if (opts.source) {
            metadata.source = opts.source;
        }

        return await ingestDocument(
            opts.contentType,
            data,
            metadata,
            opts.config,
            userId ?? undefined,
            { id: opts.id, createdAt: opts.createdAt },
        );
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
            opts?.metadata,
            opts?.config,
            userId ?? undefined,
            { id: opts?.id, createdAt: opts?.createdAt },
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
        await reinforceMemory(id, boost, uid ?? undefined);
        return { ok: true };
    }

    /**
     * Update an existing memory.
     * @param id The ID of the memory to update.
     * @param content New content (optional).
     * @param tags New tags (optional).
     * @param metadata New metadata (optional).
     * @param userId Optional user ID override.
     */
    async update(
        id: string,
        content?: string,
        tags?: string[],
        metadata?: Record<string, unknown>,
        userId?: string | null,
    ) {
        const uid = getUid(userId, this.defaultUserId);
        const res = await updateMemory(id, content, tags, metadata, uid ?? undefined);
        if (res.ok) {
            const item = await this.get(id, uid);
            if (item) eventBus.emit("memory_updated", item);
        }
        return res;
    }

    /**
     * Retrieve a memory by ID.
     */
    async get(
        id: string,
        userId?: string | null,
    ): Promise<MemoryItem | undefined> {
        const uid = getUid(userId, this.defaultUserId);
        const row = await q.getMem.get(id, uid);
        return row ? await parseMemory(row) : undefined;
    }

    /**
     * Delete a memory by ID.
     * @param id The ID of the memory to delete.
     * @param userId Optional user ID override.
     */
    async delete(id: string, userId?: string | null) {
        const uid = getUid(userId, this.defaultUserId);
        const item = await this.get(id, uid);
        const res = await q.delMem.run(id, uid ?? undefined);
        if (res > 0 && item) {
            eventBus.emit("memory_deleted", item);
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
        const filter: {
            userId?: string;
            sectors?: string[];
            minSalience?: number;
        } = {};
        if (userId) filter.userId = userId;
        if (opts?.sectors) filter.sectors = opts.sectors;
        if (opts?.minSalience) filter.minSalience = opts.minSalience;

        return await hsgQuery(query, limit, filter);
    }

    /**
     * Delete all memories and the profile for a user.
     * Cascades to all associated data (vectors, graph, models).
     * @param userId The ID of the user to delete.
     * @returns Number of memories deleted.
     */
    async deleteUser(userId: string) {
        const count = await this.wipeUserContent(userId);
        await q.delUser.run(userId);
        return count;
    }

    /**
     * Wipes all content (memories, vectors, graph, models) for a user
     * but preserves the user identity/profile.
     * 
     * **Integrity**: Ensures no orphaned data remains (Cascade Delete).
     * **Confidentiality**: Irreversibly destroys user data.
     * 
     * Process:
     * 1. Batched deletion of memories and associated vectors.
     * 2. Parallel deletion of Temporal Graph data (Facts, Edges).
     * 3. Deletion of learned models and configs.
     * 
     * @param userId The ID of the user to wipe content for.
     * @returns Promise resolving to the count of deleted memories.
     */
    async wipeUserContent(userId: string): Promise<number> {
        if (!userId) return 0;

        // 1. Batch delete vectors
        try {
            await vectorStore.deleteVectorsByUser(userId);
        } catch (e) {
            logger.error(
                `[Vector] Wipe error for user ${userId}:`,
                { error: e },
            );
        }

        // 2. Batch delete memories
        const deleted = await q.delMemByUser.run(userId);

        // 3. Cascade delete other user data
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
        return deleted;
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
    async listUsers() {
        const res = await q.getActiveUsers.all();
        return res.map((u) => u.userId);
    }



    /**
     * Get system-wide statistics.
     */
    async stats(): Promise<{
        memories: number;
        vectors: number;
        facts: number;
        relations: number;
    }> {
        const memories = await q.getMemCount.get(this.defaultUserId);
        const vectors = await q.getVecCount.get(this.defaultUserId);
        const facts = await q.getFactCount.get(this.defaultUserId);
        const relations = await q.getEdgeCount.get(this.defaultUserId);

        return {
            memories: memories?.c || 0,
            vectors: vectors?.c || 0,
            facts: facts?.c || 0,
            relations: relations?.c || 0,
        };
    }

    private _temporal?: any;

    /**
     * Temporal Graph features.
     */
    get temporal() {
        if (!this._temporal) {
            this._temporal = {
                add: async (
                    subject: string,
                    predicate: string,
                    object: string,
                    opts?: {
                        validFrom?: Date;
                        confidence?: number;
                        metadata?: Record<string, unknown>;
                    },
                ) => {
                    return await t_store.insertFact(
                        subject,
                        predicate,
                        object,
                        opts?.validFrom,
                        opts?.confidence,
                        opts?.metadata,
                        this.defaultUserId ?? undefined,
                    );
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
                    return await t_store.updateFact(
                        id,
                        this.defaultUserId ?? undefined,
                        confidence,
                        metadata,
                    );
                },
                invalidateFact: async (id: string, validTo?: Date) => {
                    return await t_store.invalidateFact(
                        id,
                        this.defaultUserId ?? undefined,
                        validTo,
                    );
                },
                queryFacts: async (
                    subject?: string,
                    predicate?: string,
                    object?: string,
                    at?: Date,
                    minConfidence?: number,
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
                updateEdge: async (
                    id: string,
                    weight?: number,
                    metadata?: Record<string, unknown>,
                ) => {
                    return await t_store.updateEdge(
                        id,
                        { weight, metadata },
                        this.defaultUserId ?? undefined,
                    );
                },
                getEdges: async (
                    sourceId?: string,
                    targetId?: string,
                    relation?: string,
                    at?: Date,
                    limit = 100,
                    offset = 0,
                ) => {
                    return await t_query.queryEdges(
                        sourceId,
                        targetId,
                        relation,
                        at,
                        this.defaultUserId ?? undefined,
                        limit,
                        offset,
                    );
                },
                invalidateEdge: async (id: string, validTo?: Date) => {
                    return await t_store.invalidateEdge(
                        id,
                        this.defaultUserId ?? undefined,
                        validTo,
                    );
                },
                compare: async (subject: string, t1: Date, t2: Date) => {
                    return await t_timeline.compareTimePoints(
                        subject,
                        t1,
                        t2,
                        this.defaultUserId ?? undefined,
                    );
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
                    relationType?: string,
                    at?: Date,
                ) => {
                    return await t_query.getRelatedFacts(
                        factId,
                        relationType,
                        at,
                        this.defaultUserId ?? undefined,
                    );
                },
                volatile: async (subject?: string, limit = 10) => {
                    return await t_timeline.getVolatileFacts(
                        subject,
                        limit,
                        this.defaultUserId ?? undefined,
                    );
                },
            };
        }
        return this._temporal;
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
        const sources: Record<
            string,
            () => Promise<BaseSource<unknown, unknown>>
        > = {
            github: () =>
                import("../sources/github").then(
                    (m) => new m.GithubSource(this.defaultUserId ?? undefined),
                ),
            notion: () =>
                import("../sources/notion").then(
                    (m) => new m.NotionSource(this.defaultUserId ?? undefined),
                ),
            google_drive: () =>
                import("../sources/google_drive").then(
                    (m) =>
                        new m.GoogleDriveSource(
                            this.defaultUserId ?? undefined,
                        ),
                ),
            google_sheets: () =>
                import("../sources/google_sheets").then(
                    (m) =>
                        new m.GoogleSheetsSource(
                            this.defaultUserId ?? undefined,
                        ),
                ),
            google_slides: () =>
                import("../sources/google_slides").then(
                    (m) =>
                        new m.GoogleSlidesSource(
                            this.defaultUserId ?? undefined,
                        ),
                ),
            onedrive: () =>
                import("../sources/onedrive").then(
                    (m) =>
                        new m.OneDriveSource(this.defaultUserId ?? undefined),
                ),
            web_crawler: () =>
                import("../sources/web_crawler").then(
                    (m) =>
                        new m.WebCrawlerSource(this.defaultUserId ?? undefined),
                ),
        };

        if (!(name in sources)) {
            throw new Error(`unknown source: ${name}`);
        }

        return await sources[name]();
    }
}

/**
 * Normalizes userId for the current context.
 */
const getUid = (userId: string | null | undefined, defaultId: string | null | undefined) => {
    return normalizeUserId(userId) || defaultId;
};
