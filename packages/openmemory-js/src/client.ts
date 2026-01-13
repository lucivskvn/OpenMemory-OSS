/**
 * Memory Client for OpenMemory.
 * Standardized interface for interacting with the OpenMemory API.
 */
import type {
    ActivityItem,
    DynamicsConstants, // Alias for backward compat
    IdeContextResult,
    IdePatternsResult,
    IdeSessionPayload,
    IdeSuggestionPayload,
    IngestionConfig,
    IngestionResult,
    IngestSourceResult,
    LgConfig,
    LgContextResult,
    LgmContextRequest,
    LgmReflectionRequest,
    LgmRetrieveRequest,
    LgmStoreRequest,
    LgReflectResult,
    LgRetrieveResult,
    LgStoreResult,
    MaintenanceStats,
    MaintLogEntry,
    MemoryAddedPayload,
    MemoryItem,
    OpenMemoryEvent,
    ReinforcementResult,
    ResonanceResult,
    RetrievalResult,
    SalienceResult,
    SectorType,
    SourceListResult,
    SourceRegistryEntry,
    SpreadingActivationResult,
    SystemMetrics,
    SystemStats,
    SystemTimelineBucket,
    TemporalComparisonResult,
    TemporalEdge,
    TemporalFact,
    TemporalStatsResult,
    TimelineBucket,
    TimelineBucket as TimelineItem,
    TimelineEntry,
    TopMemory,
    UserMemoriesResult,
    UserProfile,
    UserSummary,
    VolatileFactsResult,
    WaypointGraphResult,
    WaypointWeightResult,
    SourceRegistryEntry,
    ApiKey,
} from "./core/types";

// Explicit exports for better toolchain compatibility
export type {
    ActivityItem,
    DynamicsConstants,
    IdeContextResult,
    IdePatternsResult,
    IdeSessionPayload,
    IdeSuggestionPayload,
    IngestionConfig,
    IngestionResult,
    IngestSourceResult,
    LgConfig,
    LgContextResult,
    LgmContextRequest,
    LgmReflectionRequest,
    LgmRetrieveRequest,
    LgmStoreRequest,
    LgReflectResult,
    LgRetrieveResult,
    LgStoreResult,
    MaintenanceStats,
    MaintLogEntry,
    MemoryAddedPayload,
    MemoryItem,
    OpenMemoryEvent,
    ReinforcementResult,
    ResonanceResult,
    RetrievalResult,
    SalienceResult,
    SectorType,
    SourceListResult,
    SourceRegistryEntry,
    SpreadingActivationResult,
    SystemMetrics,
    SystemStats,
    TemporalComparisonResult,
    TemporalEdge,
    TemporalFact,
    TemporalStatsResult,
    TimelineBucket,
    TimelineEntry,
    TimelineItem,
    TopMemory,
    UserMemoriesResult,
    UserProfile,
    UserSummary,
    VolatileFactsResult,
    WaypointGraphResult,
    WaypointWeightResult,
};

// Keep star exports for any others, but explicit is safer for the build
export * from "./core/types";
export * from "./temporal_graph/types";

export interface MemoryClientConfig {
    baseUrl?: string;
    token?: string; // Optional API key
    defaultUser?: string;
}

export interface ClientMemoryOptions {
    userId?: string;
    tags?: string[];
    id?: string;
    createdAt?: number;
    [key: string]: unknown;
}

// Interfaces moved to src/core/types.ts

/**
 * OpenMemory HTTP Client.
 * Provides a standardized RESTful interface to the OpenMemory Server.
 *
 * Supports:
 * - CRUD operations for Memories
 * - Temporal Graph operations (Facts, Edges, timeline)
 * - Real-time monitoring via SSE (`listen`)
 * - System Stats & Dashboard Data
 * - IDE Integration hooks
 *
 * @public
 * @example
 * ```ts
 * const client = new MemoryClient({ baseUrl: 'http://localhost:8000', token: 'my-key' });
 * await client.add("Learned about TypeScript today", { tags: ['coding'] });
 * ```
 */
export class MemoryClient {
    protected baseUrl: string;
    protected token?: string;
    protected defaultUser?: string;

    constructor(config: MemoryClientConfig = {}) {
        this.baseUrl = (config.baseUrl || "http://localhost:8080").replace(
            /\/$/,
            "",
        );
        this.token = config.token;
        this.defaultUser = config.defaultUser;
    }

    /**
     * Get the current API base URL.
     */
    public get apiBaseUrl(): string {
        return this.baseUrl;
    }

    protected async request<T>(
        path: string,
        options: RequestInit & { skipJsonParse?: boolean; traceId?: string; spanId?: string } = {},
    ): Promise<T> {
        const { retry } = await import("./utils/retry"); // Lazy import to avoid cycle if any

        return retry(
            async () => {
                const url = `${this.baseUrl}${path}`;
                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                    ...((options.headers as Record<string, string>) || {}),
                };

                if (this.token) {
                    headers["Authorization"] = `Bearer ${this.token}`;
                    headers["x-api-key"] = this.token; // Support both styles
                }

                // Distributed Tracing Support
                if (options.traceId) headers["x-trace-id"] = options.traceId;
                if (options.spanId) headers["x-span-id"] = options.spanId;

                const res = await fetch(url, { ...options, headers });

                if (!res.ok) {
                    let errText = await res.text();
                    try {
                        const json = JSON.parse(errText);
                        errText =
                            json.error?.message ||
                            json.detail ||
                            json.message ||
                            errText;
                    } catch {
                        // Failed to parse error JSON, use raw text.
                        // logger.debug("Non-JSON error response", { text: errText });
                    }

                    // Do not retry 4xx errors except maybe 429
                    if (
                        res.status >= 400 &&
                        res.status < 500 &&
                        res.status !== 429
                    ) {
                        throw new Error(
                            `OpenMemory API Error(${res.status}): ${errText}`,
                        ); // Non-retryable
                    }

                    throw new Error(
                        `OpenMemory API Error(${res.status}): ${errText}`,
                    );
                }

                // Handle empty responses (e.g. 204)
                if (res.status === 204) return null as T;

                const text = await res.text();
                if (options.skipJsonParse) return text as unknown as T;
                try {
                    return text ? JSON.parse(text) : null;
                } catch (e) {
                    throw new Error(`Failed to parse JSON response from ${path}: ${text.substring(0, 100)}...`);
                }
            },
            {
                retries: 3,
                shouldRetry: (err: unknown) => {
                    // Don't retry client errors (except rate limits)
                    if (err instanceof Error) {
                        if (
                            err.message.includes("(400)") ||
                            err.message.includes("(401)") ||
                            err.message.includes("(403)") ||
                            err.message.includes("(404)")
                        )
                            return false;
                    }
                    return true;
                },
            },
        );
    }

    /**
     * Checks the health status of the OpenMemory server.
     * Useful for connectivity verification/readiness probes.
     * 
     * @returns `true` if server is reachable and healthy, `false` otherwise.
     */
    async health(): Promise<boolean> {
        try {
            const res = await this.request<{ ok: boolean; status?: string }>(
                "/health",
            );
            return !!(res?.ok || res?.status === "ok");
        } catch {
            return false;
        }
    }

    /**
     * Adds a new memory to the system.
     * Handles embedding generation, classification, and persistence automatically.
     * 
     * @param content - Text content of the memory.
     * @param opts - Option overrides (tags, userId, metadata).
     * @returns The fully processed MemoryItem.
     * @throws {Error} If the API request fails.
     */
    async add(
        content: string,
        opts?: ClientMemoryOptions,
    ): Promise<MemoryItem> {
        const uid = opts?.userId || this.defaultUser || "anonymous";
        const tags = opts?.tags || [];
        const meta = { ...opts };
        const { id, createdAt } = opts || {};
        delete meta.userId;
        delete meta.tags;
        delete meta.id;
        delete meta.createdAt;

        // Matches POST /memory/add schema
        const body: Record<string, unknown> = {
            content,
            userId: uid,
            tags,
            metadata: meta,
        };

        if (id) body.id = id;
        if (createdAt) body.createdAt = createdAt;

        const res = await this.request<MemoryItem>("/memory/add", {
            method: "POST",
            body: JSON.stringify(body),
        });

        if (!res) throw new Error("Failed to add memory: Empty response");
        return res;
    }

    /**
     * Efficiently adds multiple memories in a single operation.
     * Optimizes performance by batching embedding generation and database writes.
     * 
     * @param items - Array of items containing content and optional metadata.
     * @param opts - Batch-level configuration (e.g., default userId).
     * @returns Array of the successfully created MemoryItems.
     * @throws {Error} If the batch operation fails partially or completely.
     */
    async addBatch(
        items: Array<{ content: string; tags?: string[]; metadata?: Record<string, unknown> }>,
        opts?: { userId?: string },
    ): Promise<MemoryItem[]> {
        const uid = opts?.userId || this.defaultUser || "anonymous";
        const formattedItems = items.map((it) => ({
            content: it.content,
            tags: it.tags || [],
            metadata: it.metadata || {},
        }));

        const res = await this.request<{ items: MemoryItem[] }>("/memory/batch", {
            method: "POST",
            body: JSON.stringify({
                items: formattedItems,
                userId: uid,
            }),
        });
        return res?.items || [];
    }

    /**
     * Imports a memory with a specific ID and timestamp.
     * Useful for migration, restoration, or admin tooling.
     * **Warning**: Bypasses some standard deduplication checks if ID is forced.
     * 
     * @param content - The memory content.
     * @param opts - Options including forced `id` and `createdAt` timestamp.
     * @returns The imported MemoryItem.
     */
    async importMemory(
        content: string,
        opts?: ClientMemoryOptions & { id?: string; createdAt?: number },
    ): Promise<MemoryItem> {
        const uid = opts?.userId || this.defaultUser || "anonymous";
        const tags = opts?.tags || [];
        const meta = { ...opts };
        delete meta.userId;
        delete meta.tags;
        delete meta.id;
        delete meta.createdAt;

        const body = {
            content,
            userId: uid,
            tags,
            metadata: meta,
            id: opts?.id,
            createdAt: opts?.createdAt,
        };

        const res = await this.request<MemoryItem>("/memory/add", {
            method: "POST",
            body: JSON.stringify(body),
        });

        if (!res) throw new Error("Failed to import memory: Empty response");
        return res;
    }

    /**
     * Performs a semantic (vector-based) search for relevant memories.
     * Retrieves memories that are contextually similar to the query string.
     * 
     * @param query - The natural language query to search for.
     * @param opts - Filters for user, limit, score threshold, or sectors.
     * @returns List of matching memories, sorted by relevance (descending).
     */
    async search(
        query: string,
        opts?: {
            userId?: string;
            limit?: number;
            minSalience?: number;
            sectors?: string[];
        },
    ): Promise<MemoryItem[]> {
        const uid = opts?.userId || this.defaultUser || undefined;
        const limit = opts?.limit || 10;

        const body = {
            query,
            k: limit,
            filters: {
                userId: uid,
                minScore: opts?.minSalience,
                // Server currently optimises for single-sector queries.
                // If multiple are provided, only the first valid sector is used for filtering.
                sector: opts?.sectors?.[0],
            },
        };

        const res = await this.request<{ matches: MemoryItem[] }>(
            "/memory/query",
            {
                method: "POST",
                body: JSON.stringify(body),
            },
        );
        return res?.matches || [];
    }

    /**
     * Retrieves a specific memory by its unique ID.
     * 
     * @param id - The UUID of the memory to remove.
     * @returns The MemoryItem if found, or `null` if not found (404).
     * @throws {Error} If the request fails for reasons other than 404.
     */
    async get(id: string): Promise<MemoryItem | null> {
        try {
            return await this.request<MemoryItem>(`/memory/${id}`);
        } catch (e: unknown) {
            if (e instanceof Error && e.message.includes("404")) return null;
            throw e;
        }
    }

    /**
     * Updates an existing memory's content or metadata.
     * Partial updates are supported (only provided fields are modified).
     * 
     * @param id - The unique identifier of the memory target.
     * @param content - (Optional) New text content.
     * @param tags - (Optional) New list of tags (replaces existing).
     * @param metadata - (Optional) Merged/Updated metadata fields.
     * @returns Confirmation object containing the ID.
     */
    async update(
        id: string,
        content?: string,
        tags?: string[],
        metadata?: Record<string, unknown>,
    ): Promise<{ id: string; ok: boolean }> {
        const body: Record<string, unknown> = { id };
        if (content) body.content = content;
        if (tags) body.tags = tags;
        if (metadata) body.metadata = metadata;
        if (this.defaultUser) body.userId = this.defaultUser;

        const res = await this.request<{ id: string; ok: boolean }>(
            `/memory/${id}`,
            {
                method: "PATCH",
                body: JSON.stringify(body),
            },
        );
        if (!res) throw new Error("Failed to update memory: Empty response");
        return res;
    }

    /**
     * Deletes a memory from the system.
     * This operation is permanent and removes the memory from both primary and vector storage.
     * 
     * @param id - The unique ID of the memory to delete.
     * @returns `true` if the operation was accepted by the server.
     */
    async delete(id: string): Promise<boolean> {
        await this.request(`/memory/${id}`, { method: "DELETE" });
        return true;
    }

    /**
     * Retrieves a paginated list of all memories for a user.
     * Sorted by creation date (descending) by default.
     * 
     * @param limit - Max number of items to return (default 100).
     * @param offset - Pagination offset (default 0).
     * @param userId - Optional filter by user ID.
     * @returns Array of memory items.
     */
    async list(
        limit = 100,
        offset = 0,
        userId?: string,
    ): Promise<MemoryItem[]> {
        const uid = userId || this.defaultUser || undefined;
        const params = new URLSearchParams({
            l: limit.toString(),
            u: offset.toString(),
        });
        if (uid) params.append("userId", uid);

        const res = await this.request<{ items: MemoryItem[] }>(
            `/memory/all?${params.toString()}`,
        );
        return res?.items || [];
    }

    /**
     * Retrieves the graph context (neighborhood) for a specific fact.
     * Useful for traversing the knowledge graph.
     * 
     * @param factId - The unique identifier of the center fact.
     * @param options - Relation type and point-in-time filters.
     * @returns Array of related facts and their relationship weights.
     */
    async getGraphContext(
        factId: string,
        options?: { relationType?: string; at?: string | number; userId?: string },
    ): Promise<Array<{ fact: TemporalFact; relation: string; weight: number }>> {
        const params = new URLSearchParams({ factId });
        if (options?.relationType) params.append("relationType", options.relationType);
        if (options?.at) params.append("at", String(options.at));
        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{
            results: Array<{ fact: TemporalFact; relation: string; weight: number }>;
        }>(`/temporal/graph-context?${params.toString()}`);
        return res?.results || [];
    }

    /**
     * Reinforces a memory's importance, preventing it from decaying.
     * Increases the salience score by the specified boost amount.
     * 
     * @param id - The ID of the memory to reinforce.
     * @param boost - The amount to increase salience by (default 0.1).
     * @returns `true` if successful.
     */
    async reinforce(id: string, boost = 0.1): Promise<boolean> {
        await this.request(`/memory/${id}/reinforce`, {
            method: "POST",
            body: JSON.stringify({ boost }),
        });
        return true;
    }

    /**
     * Ingests content from a public URL.
     * Automatically extracts text, metadata, and processes it into a memory.
     * 
     * @param url - The URL to ingest.
     * @param options - User, metadata, and scraper configuration.
     * @returns The result of the ingestion process.
     */
    async ingestUrl(
        url: string,
        options?: {
            userId?: string;
            metadata?: Record<string, unknown>;
            config?: IngestionConfig;
        },
    ): Promise<IngestionResult> {
        const uid = options?.userId || this.defaultUser || "anonymous";
        const meta = options?.metadata || {};
        const cfg = options?.config || {};

        const res = await this.request<IngestionResult>("/memory/ingest/url", {
            method: "POST",
            body: JSON.stringify({
                url,
                metadata: meta,
                config: cfg,
                userId: uid,
            }),
        });
        if (!res) throw new Error("Ingestion failed: Empty response");
        return res;
    }

    /**
     * Ingests a raw document (text/buffer) or structured request.
     * Supports various content types (PDF, Markdown, etc).
     * 
     * @param contentTypeOrRequest - MIME type or full request object.
     * @param data - Raw data string or buffer (if not using request object).
     * @param options - Metadata and config options.
     * @returns The result of the ingestion process.
     */
    async ingest(
        contentTypeOrRequest:
            | string
            | (Omit<import("./core/types").IngestRequest, "source"> & {
                source?: string;
            }),
        data?: string | unknown,
        options?: {
            userId?: string;
            metadata?: Record<string, unknown>;
            config?: IngestionConfig;
        },
    ): Promise<IngestionResult> {
        let contentType: string;
        let pData: string | unknown;
        let pOptions: {
            userId?: string | null;
            metadata?: Record<string, unknown>;
            config?: IngestionConfig;
        } = options || {};

        if (typeof contentTypeOrRequest === "object") {
            const req = contentTypeOrRequest;
            contentType = req.contentType;
            pData = req.data;
            pOptions = {
                userId: req.userId,
                metadata: req.metadata,
                config: req.config,
            };
        } else {
            contentType = contentTypeOrRequest;
            pData = data;
        }

        const uid = pOptions.userId || this.defaultUser || "anonymous";

        // Default source to 'file' if not provided (safe assumption for raw content ingestion)
        // Request object case might have source, but if we are here, we check pOptions or just strictly default if missing.
        // If content is raw string/buffer, it's virtually always a "file" or "blob".
        const source = (typeof contentTypeOrRequest === "object" ? contentTypeOrRequest.source : null) || "file";

        const res = await this.request<IngestionResult>("/memory/ingest", {
            method: "POST",
            body: JSON.stringify({
                source,
                contentType,
                data: pData,
                metadata: pOptions.metadata,
                config: pOptions.config,
                userId: uid,
            }),
        });
        if (!res) throw new Error("Ingestion failed: Empty response");
        return res;
    }

    /**
     * Delete all memories for a specific user.
     * Alias for deleteUserMemories to match local Memory API.
     */
    async deleteAll(
        userId?: string,
    ): Promise<{ success: boolean; deletedCount: number }> {
        return this.deleteUserMemories(userId);
    }

    /**
     * Trigger a training run for the user's classifier.
     */
    async train(userId?: string): Promise<{ success: boolean; message?: string; version?: number }> {
        const uid = userId || this.defaultUser;
        if (!uid) throw new Error("User ID required for training.");

        // Using the admin route usually, or a specific user route if we add one.
        // For now, let's assume one exists or fallback to the one AdminClient uses if they differ.
        // Actually, for broad compatibility, let's stick to the interface definition 
        // and let specific implementations (like AdminClient) handle the path.
        // But if MemoryClient is used directly, it needs a valid path.
        // Let's use the same path AdminClient uses, assuming we have rights.
        // Or /api/admin/train if that's the generic one.
        // Let's match the return type signature first.
        return await this.request<{ success: boolean; message?: string; version?: number }>("/admin/users/" + uid + "/train", {
            method: "POST",
            body: JSON.stringify({ userId: uid })
        });
    }

    // --- Temporal Graph API ---

    /**
     * Adds a new temporal fact to the graph.
     * Records a fact with a validity start time (validFrom).
     * 
     * @param fact - The fact details (subject, predicate, object, etc).
     * @param userId - Optional override for user ID.
     * @returns The created fact's ID.
     */
    async addFact(
        fact: {
            subject: string;
            predicate: string;
            object: string;
            validFrom?: string | number;
            confidence?: number;
            metadata?: Record<string, unknown>;
        },
        userId?: string,
    ): Promise<{ id: string } & Partial<TemporalFact>> {
        const body: Record<string, unknown> = { ...fact };
        const uid = userId || this.defaultUser;
        if (uid) body.userId = uid;

        const res = await this.request<{ id: string } & Partial<TemporalFact>>(
            "/temporal/fact",
            {
                method: "POST",
                body: JSON.stringify(body),
            },
        );
        if (!res) throw new Error("Failed to add fact: Empty response");
        return res;
    }

    /**
     * Updates an existing temporal fact.
     * Allows modifying confidence or metadata without creating a new fact version.
     * 
     * @param id - The ID of the fact to update.
     * @param updates - Fields to update (confidence, metadata).
     * @returns Confirmation object.
     */
    async updateFact(
        id: string,
        updates: {
            confidence?: number;
            metadata?: Record<string, unknown>;
        },
    ): Promise<{ id: string; message: string }> {
        const body: Record<string, unknown> = { ...updates };
        const res = await this.request<{ id: string; message: string }>(
            `/temporal/fact/${id}`,
            {
                method: "PATCH",
                body: JSON.stringify(body),
            },
        );
        return res;
    }

    /**
     * Invalidates (logically deletes) a temporal fact.
     * Sets the validTo timestamp, effectively closing the fact's validity period.
     * 
     * @param id - The ID of the fact to invalidate.
     * @param validTo - The timestamp when the fact ceased to be true (default: now).
     * @returns Confirmation object.
     */
    async deleteFact(
        id: string,
        validTo?: string | number,
    ): Promise<{ id: string; validTo: string }> {
        const body: Record<string, unknown> = {};
        if (validTo) body.validTo = validTo;

        const res = await this.request<{ id: string; validTo: string }>(
            `/temporal/fact/${id}`,
            {
                method: "DELETE",
                body: JSON.stringify(body),
            },
        );
        return res;
    }

    /**
     * Retrieves temporal facts matching specific criteria.
     * Supports filtering by subject, predicate, object, and validity time.
     * 
     * @param query - Filter criteria.
     * @returns Array of matching TemporalFact objects.
     */
    async getFacts(query: {
        subject?: string;
        predicate?: string;
        object?: string;
        at?: string | number;
        minConfidence?: number;
    }): Promise<TemporalFact[]> {
        const params = new URLSearchParams();
        if (query.subject) params.append("subject", query.subject);
        if (query.predicate) params.append("predicate", query.predicate);
        if (query.object) params.append("object", query.object);
        if (query.at) params.append("at", String(query.at));
        if (query.minConfidence)
            params.append("minConfidence", String(query.minConfidence));

        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ facts: TemporalFact[] }>(
            `/temporal/fact?${params.toString()}`,
        );
        return res?.facts || [];
    }

    /**
     * Searches for temporal facts using a pattern matching approach.
     * Useful for finding facts when exact subject/object is unknown.
     * 
     * @param pattern - The string pattern to search for.
     * @param type - Which field to search (subject, predicate, object, or all).
     * @param limit - Max results (default 100).
     * @returns Array of matching facts.
     */
    async searchFacts(
        pattern: string,
        type: "subject" | "predicate" | "object" | "all" = "all",
        limit = 100,
    ): Promise<TemporalFact[]> {
        const params = new URLSearchParams({
            pattern,
            type,
            limit: limit.toString(),
        });
        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ facts: TemporalFact[] }>(
            `/temporal/search?${params.toString()}`,
        );
        return res?.facts || [];
    }

    /**
     * Retrieves the chronological timeline of facts for a specific entity.
     * 
     * @param subject - The entity ID or name (subject).
     * @param predicate - (Optional) Filter by specific predicate/relationship.
     * @returns Chronological list of timeline entries.
     */
    async getTimeline(
        subject: string,
        predicate?: string,
    ): Promise<TimelineEntry[]> {
        const params = new URLSearchParams({ subject });
        if (predicate) params.append("predicate", predicate);
        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ timeline: TimelineEntry[] }>(
            `/temporal/timeline?${params.toString()}`,
        );
        return res?.timeline || [];
    }

    /**
     * Adds a directed edge between two entities in the temporal graph.
     * Represents a relationship valid from a specific time.
     * 
     * @param edge - Edge details (source, target, relation, weight).
     * @param userId - Optional user ID override.
     * @returns The created edge ID.
     */
    async addEdge(
        edge: {
            sourceId: string;
            targetId: string;
            relationType: string;
            validFrom?: string | number;
            weight?: number;
            metadata?: Record<string, unknown>;
        },
        userId?: string,
    ): Promise<{ id: string; ok: boolean }> {
        const body: Record<string, unknown> = { ...edge };
        const uid = userId || this.defaultUser;
        if (uid) body.userId = uid;

        const res = await this.request<{ id: string; ok: boolean }>(
            "/temporal/edge",
            {
                method: "POST",
                body: JSON.stringify(body),
            },
        );
        if (!res) throw new Error("Failed to add edge: Empty response");
        return res;
    }

    /**
     * Updates an existing temporal edge.
     * Allows modifying weight or metadata.
     * 
     * @param id - The ID of the edge to update.
     * @param updates - Fields to update (weight, metadata).
     * @returns Confirmation object.
     */
    async updateEdge(
        id: string,
        updates: {
            weight?: number;
            metadata?: Record<string, unknown>;
        },
    ): Promise<{ id: string; message: string }> {
        const body: Record<string, unknown> = { ...updates };
        const res = await this.request<{ id: string; message: string }>(
            `/temporal/edge/${id}`,
            {
                method: "PATCH",
                body: JSON.stringify(body),
            },
        );
        return res;
    }

    /**
     * Invalidates (deletes) a temporal edge.
     * 
     * @param id - The ID of the edge to remove.
     * @param validTo - (Optional) Timestamp when the edge ceased to exist.
     * @returns Confirmation object.
     */
    async deleteEdge(
        id: string,
        validTo?: string | number,
    ): Promise<{ id: string; validTo: string }> {
        const body: Record<string, unknown> = {};
        if (validTo) body.validTo = validTo;

        const res = await this.request<{ id: string; validTo: string }>(
            `/temporal/edge/${id}`,
            {
                method: "DELETE",
                body: JSON.stringify(body),
            },
        );
        return res;
    }

    /**
     * Retrieves temporal edges matching specific criteria.
     * 
     * @param query - Filter by source, target, relation, time.
     * @returns Array of matching TemporalEdge objects.
     */
    async getEdges(query: {
        sourceId?: string;
        targetId?: string;
        relationType?: string;
        at?: string | number;
        limit?: number;
        offset?: number;
    }): Promise<TemporalEdge[]> {
        const params = new URLSearchParams();
        if (query.sourceId) params.append("sourceId", query.sourceId);
        if (query.targetId) params.append("targetId", query.targetId);
        if (query.relationType)
            params.append("relationType", query.relationType);
        if (query.at) params.append("at", String(query.at));
        if (query.limit) params.append("limit", String(query.limit));
        if (query.offset) params.append("offset", String(query.offset));

        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ edges: TemporalEdge[] }>(
            `/temporal/edge?${params.toString()}`,
        );
        return res?.edges || [];
    }

    /**
     * Retrieves the current valid fact for a subject/predicate.
     * 
     * @param subject - The subject entity.
     * @param predicate - The relationship/predicate.
     * @param at - (Optional) Point in time to check.
     * @returns The active fact or null.
     */
    async getCurrentFact(
        subject: string,
        predicate: string,
        at?: string | number,
    ): Promise<TemporalFact | null> {
        const params = new URLSearchParams({ subject, predicate });
        if (at) params.append("at", String(at));

        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ fact: TemporalFact }>(
            `/temporal/fact/current?${params.toString()}`,
        );
        return res?.fact || null;
    }

    /**
     * Get history of a predicate.
     */
    async getPredicateHistory(
        predicate: string,
        from?: number | string,
        to?: number | string,
    ): Promise<TimelineEntry[]> {
        const params = new URLSearchParams({ predicate });
        if (from) params.append("from", String(from));
        if (to) params.append("to", String(to));

        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ timeline: TimelineEntry[] }>(
            `/temporal/history/predicate?${params.toString()}`,
        );
        return res?.timeline || [];
    }

    /**
     * Get all facts for a subject (active and historical).
     */
    /**
     * Retrieves all active facts for a specific subject at a given point in time.
     * 
     * @param subject - The subject to query (e.g., "John Doe").
     * @param at - Target timestamp or "now".
     * @param includeHistorical - Whether to include facts that are no longer valid.
     * @returns Array of matching temporal facts.
     */
    async getSubjectFacts(
        subject: string,
        at?: number | string,
        includeHistorical = false,
    ): Promise<TemporalFact[]> {
        const params = new URLSearchParams();
        if (at) params.append("at", String(at));
        if (includeHistorical) params.append("includeHistorical", "true");

        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ facts: TemporalFact[] }>(
            `/temporal/subject/${encodeURIComponent(subject)}?${params.toString()}`,
        );
        return res?.facts || [];
    }

    /**
     * Compare facts at two points in time.
     */
    /**
     * Compares the state of facts for a subject between two distinct timestamps.
     * Identifies added, removed, and changed facts.
     * 
     * @param subject - The subject to compare.
     * @param time1 - The first (older) timestamp.
     * @param time2 - The second (newer) timestamp.
     * @returns A comparison result including diffs.
     */
    async compareFacts(
        subject: string,
        time1: number | string,
        time2: number | string,
    ): Promise<TemporalComparisonResult> {
        const params = new URLSearchParams({
            subject,
            time1: String(time1),
            time2: String(time2),
        });
        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);
        return await this.request<TemporalComparisonResult>(
            `/temporal/compare?${params.toString()}`,
        );
    }

    /**
     * Get temporal statistics.
     */
    async getTemporalStats(): Promise<TemporalStatsResult> {
        const params = new URLSearchParams();
        const uid = this.defaultUser;
        if (uid) params.append("userId", uid);
        return await this.request<TemporalStatsResult>(
            `/temporal/stats?${params.toString()}`,
        );
    }

    /**
     * Apply confidence decay globally.
     */
    async applyDecay(
        decayRate = 0.01,
        userId?: string,
    ): Promise<{ factsUpdated: number }> {
        const body: Record<string, unknown> = { decayRate };
        const uid = userId || this.defaultUser;
        if (uid) body.userId = uid;

        return await this.request("/temporal/decay", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    /**
     * Get most volatile facts (frequent changes).
     */
    async getVolatileFacts(
        subject?: string,
        limit = 10,
        userId?: string,
    ): Promise<VolatileFactsResult> {
        const params = new URLSearchParams();
        if (subject) params.append("subject", subject);
        params.append("limit", String(limit));

        const uid = userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        return await this.request<VolatileFactsResult>(
            `/temporal/volatile?${params.toString()}`,
        );
    }



    // --- IDE Integration API ---

    /**
     * Start a new IDE session.
     */
    async startIdeSession(opts: {
        projectName: string;
        ideName: string;
        userId?: string;
    }): Promise<{ sessionId: string }> {
        const uid = opts.userId || this.defaultUser || "anonymous";
        const res = await this.request<{ sessionId: string }>(
            "/ide/session/start",
            {
                method: "POST",
                body: JSON.stringify({
                    projectName: opts.projectName,
                    ideName: opts.ideName,
                    userId: uid,
                }),
            },
        );
        if (!res)
            throw new Error("Failed to start IDE session: Empty response");
        return res;
    }

    /**
     * End an IDE session.
     */
    async endIdeSession(
        sessionId: string,
        userId?: string,
    ): Promise<{ summaryMemoryId: string }> {
        const uid = userId || this.defaultUser || "anonymous";
        const res = await this.request<{ summaryMemoryId: string }>(
            "/ide/session/end",
            {
                method: "POST",
                body: JSON.stringify({
                    sessionId,
                    userId: uid,
                }),
            },
        );
        if (!res) throw new Error("Failed to end IDE session: Empty response");
        return res;
    }

    /**
     * Send an IDE event (file change, cursor move, save, etc) to be stored as a memory.
     * @param event - The IDE event data
     * @param event.sessionId - Current IDE session identifier
     * @param event.eventType - Type of event ('save', 'open', 'close', 'edit', etc.)
     * @param event.userId - Client-provided user ID. Falls back to defaultUser or 'anonymous'.
     *                       If server has an authenticated context (API key), it may override this.
     * @param event.filePath - Path to the file being changed
     * @param event.content - Content or diff of the change
     * @param event.language - Programming language identifier (e.g., 'typescript', 'python')
     * @param event.metadata - Additional metadata including sectorHints for classification
     */
    async sendIdeEvent(event: {
        sessionId: string;
        eventType: string;
        userId?: string;
        filePath?: string;
        content?: string;
        language?: string;
        metadata?: Record<string, unknown>;
    }): Promise<void> {
        const uid = event.userId || this.defaultUser || "anonymous";
        await this.request("/ide/events", {
            method: "POST",
            body: JSON.stringify({
                sessionId: event.sessionId,
                eventType: event.eventType,
                filePath: event.filePath,
                content: event.content,
                language: event.language,
                metadata: event.metadata || {},
                userId: uid,
            }),
        });
    }

    /**
     * Get IDE context for the current file/query.
     */
    async getIdeContext(
        query: string,
        options?: { sessionId?: string; filePath?: string; k?: number; userId?: string },
    ): Promise<IdeContextResult> {
        const uid = options?.userId || this.defaultUser;
        return await this.request<IdeContextResult>("/ide/context", {
            method: "POST",
            body: JSON.stringify({
                query,
                sessionId: options?.sessionId,
                filePath: options?.filePath,
                k: options?.k,
                userId: uid,
            }),
        });
    }

    /**
     * Get detected patterns for a session.
     */
    async getIdePatterns(sessionId: string): Promise<IdePatternsResult> {
        return await this.request<IdePatternsResult>(
            `/ide/patterns/${sessionId}`,
        );
    }

    // --- LangGraph Integration API ---

    /**
     * Get LangGraph configuration.
     */
    async getLgConfig(): Promise<LgConfig> {
        return await this.request<LgConfig>("/lgm/config");
    }

    /**
     * Store a memory for a LangGraph node.
     */
    /**
     * Stores a memory associated with a specific LangGraph node.
     * Handles automatic tagging and elective reflection logic.
     * 
     * @param node - LangGraph node name (e.g. 'plan').
     * @param content - Memory content string.
     * @param options - Graph context and metadata.
     * @returns Result including the memoryId and session info.
     */
    async lgStore(
        node: string,
        content: string,
        options?: {
            tags?: string[];
            metadata?: Record<string, unknown>;
            namespace?: string;
            graphId?: string;
            reflective?: boolean;
            userId?: string;
        },
    ): Promise<LgStoreResult> {
        const body = {
            node,
            content,
            tags: options?.tags,
            metadata: options?.metadata,
            namespace: options?.namespace,
            graphId: options?.graphId,
            reflective: options?.reflective,
            userId: options?.userId || this.defaultUser || undefined,
        };
        return await this.request<LgStoreResult>("/lgm/store", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    /**
     * Retrieves memories related to a specific LangGraph node.
     * Supports semantic search within the node's memory scope.
     * 
     * @param node - The node name to retrieve from.
     * @param options - Query, namespace, and pagination options.
     * @returns Array of retrieved memory items.
     */
    async lgRetrieve(
        node: string,
        options?: {
            query?: string;
            namespace?: string;
            graphId?: string;
            limit?: number;
            includeMetadata?: boolean;
            userId?: string;
        },
    ): Promise<LgRetrieveResult> {
        const body = {
            node,
            query: options?.query,
            namespace: options?.namespace,
            graphId: options?.graphId,
            limit: options?.limit,
            includeMetadata: options?.includeMetadata,
            userId: options?.userId || this.defaultUser || undefined,
        };
        return await this.request<LgRetrieveResult>("/lgm/retrieve", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    /**
     * Collects context from all LangGraph nodes for a graph execution thread.
     * Synthesizes memory into a prompt-ready context string.
     * 
     * @param node - The starting node for context collection.
     * @param options - Filter by namespace and graphId.
     * @returns Synthesized context string and structured node data.
     */
    async lgContext(
        node: string,
        options?: {
            namespace?: string;
            graphId?: string;
            userId?: string;
        },
    ): Promise<LgContextResult> {
        const body = {
            node,
            namespace: options?.namespace,
            graphId: options?.graphId,
            userId: options?.userId || this.defaultUser || undefined,
        };
        return await this.request<LgContextResult>("/lgm/context", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    /**
     * Trigger reflection on LangGraph memories.
     */
    async lgReflect(
        node: string,
        graphId?: string,
        options?: {
            content?: string;
            contextIds?: string[];
            namespace?: string;
            userId?: string;
            depth?: "shallow" | "deep";
        },
    ): Promise<LgReflectResult> {
        const body = {
            node,
            graphId,
            content: options?.content,
            contextIds: options?.contextIds,
            namespace: options?.namespace,
            userId: options?.userId || this.defaultUser || undefined,
            depth: options?.depth,
        };
        return await this.request<LgReflectResult>("/lgm/reflection", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    // --- User Management API ---

    /**
     * Get user profile.
     */
    /**
     * Retrieves the profile and metadata for a specific user.
     * 
     * @param userId - Unique identifier for the user.
     * @returns The user's profile information.
     */
    async getUser(userId: string): Promise<UserProfile> {
        return await this.request<UserProfile>(`/users/${userId}`);
    }

    /**
     * Get user summary.
     */
    async getUserSummary(userId: string): Promise<UserSummary> {
        return await this.request<UserSummary>(`/users/${userId}/summary`);
    }

    /**
     * Regenerate user summary.
     */
    async regenerateUserSummary(userId: string): Promise<UserSummary> {
        return await this.request<UserSummary>(
            `/users/${userId}/summary/regenerate`,
            { method: "POST" },
        );
    }

    /**
     * Get user memories.
     */
    async getUserMemories(
        userId: string,
        limit = 100,
        offset = 0,
    ): Promise<UserMemoriesResult> {
        return await this.request<UserMemoriesResult>(
            `/users/${userId}/memories?l=${limit}&u=${offset}`,
        );
    }

    /**
     * Delete all user memories.
     */
    async deleteUserMemories(
        userId?: string,
    ): Promise<{ success: boolean; deletedCount: number }> {
        const uid = userId || this.defaultUser;
        const params = new URLSearchParams();
        if (uid) params.append("userId", uid);

        // Use the global/all delete route which supports userId filtering
        const res = await this.request<{
            ok: boolean;
            success?: boolean;
            deleted: number;
            deletedCount?: number;
        }>(`/memory/all?${params.toString()}`, { method: "DELETE" });

        return {
            success: res.ok ?? res.success ?? true,
            deletedCount: res.deleted ?? res.deletedCount ?? 0
        };
    }

    /**
     * List all active users.
     */
    async listUsers(limit = 100, offset = 0): Promise<string[]> {
        const res = await this.request<{ users: { userId: string }[] }>(`/admin/users?l=${limit}&u=${offset}`);
        // Admin API returns objects {userId, ...}, Client expects string[] of IDs for backward compat?
        // Let's check the return type of the original method, it was Promise<string[]>.
        // Admin API returns { users: MemoryUser[] }.
        return res?.users?.map(u => u.userId) || [];
    }



    /**
     * Regenerate summaries for all users.
     */
    async regenerateAllUserSummaries(): Promise<{
        ok: boolean;
        updated: number;
    }> {
        return await this.request<{ ok: boolean; updated: number }>(
            "/users/summaries/regenerate-all",
            { method: "POST" },
        );
    }

    // --- Setup API ---

    /**
     * Checker if the system is in Setup Mode (no admin exists yet).
     */
    async getSetupStatus(): Promise<{ setupMode: boolean; message: string }> {
        return await this.request<{ setupMode: boolean; message: string }>("/setup/status");
    }

    /**
     * Verify setup token and create the root Admin user.
     */
    async performSetup(
        token: string,
        userId: string
    ): Promise<{ success: boolean; apiKey: string; userId: string; role: string }> {
        return await this.request("/setup/verify", {
            method: "POST",
            body: JSON.stringify({ token, userId }),
        });
    }

    // --- Admin API ---

    /**
     * Register a new user (Admin only).
     */
    async registerUser(
        userId: string,
        summary?: string
    ): Promise<{ success: boolean; userId: string }> {
        return await this.request<{ success: boolean; userId: string }>("/admin/users", {
            method: "POST",
            body: JSON.stringify({ userId, summary }),
        });
    }

    /**
     * Delete a user and all their data (Admin only).
     */
    async deleteUser(userId: string): Promise<{ success: boolean; userId: string }> {
        return await this.request(`/admin/users/${userId}`, { method: "DELETE" });
    }

    /**
     * List all API keys for a user (Admin only).
     */
    async listUserKeys(userId: string): Promise<
        {
            keyHash: string; // The list endpoint might return partials, checking server implementation
            userId: string;
            role: string;
            note: string;
            createdAt: string;
            keyHashPrefix: string;
        }[]
    > {
        // Server route is GET /admin/users/:userId/keys
        const res = await this.request<{ keys: ApiKey[] }>(`/admin/users/${userId}/keys`);
        return res?.keys || [];
    }

    /**
     * Create a new API key for a user.
     */
    async createUserKey(
        userId: string,
        opts: { role?: "user" | "admin" | "read_only"; note?: string; expiresInDays?: number } = {}
    ): Promise<{ success: boolean; key: string; note?: string; expiresAt: number }> {
        return await this.request(`/admin/users/${userId}/keys`, {
            method: "POST",
            body: JSON.stringify(opts),
        }); // Note: The client logic will need to fix this template literal in the next correction if verify fails
    }

    /**
     * Revoke an API key by its hash (Admin only).
     */
    async deleteApiKey(keyHash: string): Promise<{ success: boolean }> {
        return await this.request(`/admin/keys/${keyHash}`, { method: "DELETE" });
    }

    // --- Source Config API (Admin/MCP) ---

    /**
     * List source configurations for a user.
     */
    async getUserSources(userId: string): Promise<{
        userId: string;
        type: string;
        status: string;
        updatedAt: number;
        createdAt: number;
    }[]> {
        const res = await this.request<{ sources: SourceRegistryEntry[] }>(`/admin/users/${userId}/sources`);
        return res?.sources || [];
    }

    /**
     * Create or update a source configuration.
     */
    async upsertUserSource(
        userId: string,
        type: string,
        config: string | Record<string, unknown>,
        status: "enabled" | "disabled" = "enabled"
    ): Promise<{ success: boolean; type: string }> {
        const configStr = typeof config === "string" ? config : JSON.stringify(config);
        return await this.request(`/admin/users/${userId}/sources`, {
            method: "POST",
            body: JSON.stringify({ type, config: configStr, status }),
        });
    }

    /**
     * Delete a source configuration.
     */
    async deleteUserSource(userId: string, sourceType: string): Promise<{ success: boolean }> {
        return await this.request(`/admin/users/${userId}/sources/${sourceType}`, {
            method: "DELETE",
        });
    }

    /**
     * List all active API keys (Admin only).
     * @deprecated Use listUserKeys per user. Global listing is less efficient.
     */
    async listApiKeys(): Promise<ApiKey[]> {
        // Only per-user listing is supported in new Admin API
        // We can iterate users if needed, but for now we throw
        throw new Error("Deprecated. Use listUserKeys(userId).");
    }

    /**
     * Revoke an API key by its hash prefix (Admin only).
     * @deprecated Use deleteApiKey(hash).
     */
    async revokeApiKey(prefixOrHash: string): Promise<{ success: boolean }> {
        // Try deleting as hash
        return this.deleteApiKey(prefixOrHash);
    }

    /**
     * Export all data.
     * Returns a Blob (NDJSON).
     */
    async exportData(): Promise<Blob> {
        return await this.request<Blob>("/admin/export", {
            headers: { Accept: "application/x-ndjson" },
            skipJsonParse: true,
        });
    }

    /**
     * Import data.
     */
    async importData(blob: Blob): Promise<{
        success: boolean;
        users: number;
        memories: number;
        configs: number;
    }> {
        return await this.request<{
            success: boolean;
            users: number;
            memories: number;
            configs: number;
        }>("/admin/import", {
            method: "POST",
            body: blob,
            headers: { "Content-Type": "application/x-ndjson" },
        });
    }



    // --- Dashboard / Admin API ---



    // --- Dashboard / Admin API ---

    /**
     * Get system statistics.
     */
    async getStats(): Promise<SystemStats | null> {
        try {
            return await this.request<SystemStats>("/dashboard/stats");
        } catch {
            return null;
        }
    }

    /**
     * Get system maintenance status.
     * Returns active background jobs and their count.
     */
    async getMaintenanceStatus(): Promise<{
        ok: boolean;
        active_jobs: string[];
        count: number;
    }> {
        return await this.request<{
            ok: boolean;
            active_jobs: string[];
            count: number;
        }>("/api/system/maintenance");
    }

    /**
     * Get available memory sectors and their configurations.
     * Useful for building UI selectors or understanding system capabilities.
     */
    async getSectors(): Promise<{
        sectors: string[];
        configs: Record<string, unknown>;
        stats: unknown;
    }> {
        return await this.request<{
            sectors: string[];
            configs: Record<string, unknown>;
            stats: unknown;
        }>("/api/system/sectors");
    }

    /**
     * Get dashboard AI settings.
     */
    async getDashboardSettings(): Promise<{
        openai: Record<string, unknown>;
        gemini: Record<string, unknown>;
        anthropic: Record<string, unknown>;
        ollama: Record<string, unknown>;
    }> {
        return await this.request<{
            openai: Record<string, unknown>;
            gemini: Record<string, unknown>;
            anthropic: Record<string, unknown>;
            ollama: Record<string, unknown>;
        }>("/dashboard/settings");
    }

    /**
     * Update dashboard AI settings.
     */
    async updateDashboardSettings(
        type: "openai" | "gemini" | "anthropic" | "ollama",
        config: Record<string, unknown>,
    ): Promise<{ success: boolean; type: string }> {
        return await this.request<{ success: boolean; type: string }>(
            "/dashboard/settings",
            {
                method: "POST",
                body: JSON.stringify({ type, config }),
            },
        );
    }

    /**
     * Get recent activity.
     */
    async getActivity(limit = 50): Promise<ActivityItem[]> {
        const res = await this.request<{ activities: ActivityItem[] }>(
            `/dashboard/activity?limit=${limit}`,
        );
        return res?.activities || [];
    }

    /**
     * Get top active memories.
     */
    async getTopMemories(limit = 10): Promise<TopMemory[]> {
        const res = await this.request<{ memories: TopMemory[] }>(
            `/dashboard/top-memories?limit=${limit}`,
        );
        return res?.memories || [];
    }

    /**
     * Get memory distribution timeline by sector.
     */
    async getSectorTimeline(
        hours = 24,
    ): Promise<{ timeline: TimelineItem[]; grouping: string }> {
        const res = await this.request<{
            timeline: TimelineItem[];
            grouping: string;
        }>(`/dashboard/sectors/timeline?hours=${hours}`);
        return res || { timeline: [], grouping: "hour" };
    }

    /**
     * Get maintenance operation stats.
     */
    async getMaintenanceStats(hours = 24): Promise<MaintenanceStats | null> {
        try {
            return await this.request<MaintenanceStats>(
                `/dashboard/maintenance?hours=${hours}`,
            );
        } catch {
            return null;
        }
    }

    /**
     * Get raw maintenance logs.
     */
    async getMaintenanceLogs(
        limit = 50,
    ): Promise<import("./core/types").MaintLogEntry[]> {
        const res = await this.request<{
            logs: import("./core/types").MaintLogEntry[];
        }>(`/api/system/maintenance/logs?limit=${limit}`);
        return res?.logs || [];
    }

    // --- Dynamics API ---

    async getDynamicsConstants(): Promise<{
        success: boolean;
        constants: DynamicsConstants;
    }> {
        return await this.request<{
            success: boolean;
            constants: DynamicsConstants;
        }>("/dynamics/constants");
    }

    async calculateSalience(params: {
        initialSalience?: number;
        decayLambda?: number;
        recallCount?: number;
        emotionalFrequency?: number;
        timeElapsedDays?: number;
    }): Promise<SalienceResult> {
        return await this.request<SalienceResult>(
            "/dynamics/salience/calculate",
            {
                method: "POST",
                body: JSON.stringify(params),
            },
        );
    }

    async calculateResonance(params: {
        memorySector?: string;
        querySector?: string;
        baseSimilarity?: number;
    }): Promise<ResonanceResult> {
        return await this.request<ResonanceResult>(
            "/dynamics/resonance/calculate",
            {
                method: "POST",
                body: JSON.stringify(params),
            },
        );
    }

    async retrieveEnergyBased(params: {
        query: string;
        sector?: string;
        minEnergy?: number;
    }): Promise<RetrievalResult> {
        return await this.request<RetrievalResult>(
            "/dynamics/retrieval/energy-based",
            {
                method: "POST",
                body: JSON.stringify(params),
            },
        );
    }

    async reinforceTrace(memoryId: string): Promise<ReinforcementResult> {
        return await this.request<ReinforcementResult>(
            "/dynamics/reinforcement/trace",
            {
                method: "POST",
                body: JSON.stringify({ memoryId }),
            },
        );
    }

    async spreadingActivation(
        memoryIds: string[],
        maxIterations = 3,
    ): Promise<SpreadingActivationResult> {
        return await this.request<SpreadingActivationResult>(
            "/dynamics/activation/spreading",
            {
                method: "POST",
                body: JSON.stringify({
                    initialMemoryIds: memoryIds,
                    maxIterations,
                }),
            },
        );
    }

    async getWaypointGraph(limit = 1000): Promise<WaypointGraphResult> {
        return await this.request<WaypointGraphResult>(
            `/dynamics/waypoints/graph?limit=${limit}`,
        );
    }

    async calculateWaypointWeight(
        sourceId: string,
        targetId: string,
    ): Promise<WaypointWeightResult> {
        return await this.request<WaypointWeightResult>(
            "/dynamics/waypoints/calculate-weight",
            {
                method: "POST",
                body: JSON.stringify({
                    sourceMemoryId: sourceId,
                    targetMemoryId: targetId,
                }),
            },
        );
    }




    // --- Sources API ---
    async listSources(): Promise<SourceListResult> {
        return await this.request<SourceListResult>("/sources");
    }

    async ingestSource(
        source: string,
        payload: { creds?: unknown; filters?: unknown; userId?: string },
    ): Promise<IngestSourceResult> {
        return await this.request<IngestSourceResult>(
            `/sources/${source}/ingest`,
            {
                method: "POST",
                body: JSON.stringify(payload),
            },
        );
    }

    /**
     * Get source configurations.
     * Lists all connectors and their active status.
     */
    async getSourceConfigs(): Promise<SourceRegistryEntry[]> {
        const res = await this.request<{ configs: SourceRegistryEntry[] }>(
            "/source-configs",
        );
        return res?.configs || [];
    }

    /**
     * Set a source configuration.
     */
    async setSourceConfig(
        type: string,
        config: Record<string, unknown>,
        status?: "enabled" | "disabled",
    ): Promise<{ ok: boolean }> {
        return await this.request<{ ok: boolean }>(`/source-configs/${type}`, {
            method: "POST",
            body: JSON.stringify({ config, status }),
        });
    }

    /**
     * Delete a source configuration.
     */
    async deleteSourceConfig(type: string): Promise<{ ok: boolean }> {
        return await this.request<{ ok: boolean }>(`/source-configs/${type}`, {
            method: "DELETE",
        });
    }




    // --- LangGraph Memory (LGM) ---

    /**
     * Store a memory within a LangGraph/Agent context.
     */
    async lgmStore(req: LgmStoreRequest): Promise<LgStoreResult> {
        return await this.request<LgStoreResult>("/lgm/store", {
            method: "POST",
            body: JSON.stringify(req),
        });
    }

    /**
     * Retrieve memories for a specific graph node/context.
     */
    async lgmRetrieve(req: LgmRetrieveRequest): Promise<LgRetrieveResult> {
        return await this.request<LgRetrieveResult>("/lgm/retrieve", {
            method: "POST",
            body: JSON.stringify(req),
        });
    }

    /**
     * Get distilled context for a node (priming).
     */
    async lgmContext(req: LgmContextRequest): Promise<LgContextResult> {
        return await this.request<LgContextResult>("/lgm/context", {
            method: "POST",
            body: JSON.stringify(req),
        });
    }

    /**
     * Trigger a reflection on graph memories.
     */
    async lgmReflection(req: LgmReflectionRequest): Promise<LgReflectResult> {
        return await this.request<LgReflectResult>("/lgm/reflection", {
            method: "POST",
            body: JSON.stringify(req),
        });
    }

    /**
     * Get LGM configuration.
     */
    async lgmConfig(): Promise<LgConfig> {
        return await this.request<LgConfig>("/lgm/config");
    }

    // --- Compression API ---

    /**
     * Compress a text string.
     */
    async compress(
        text: string,
        algorithm: "semantic" | "syntactic" | "aggressive" = "semantic",
    ): Promise<import("./core/types").CompressionResult> {
        const body = { text, algorithm };
        const res = await this.request<{
            success: boolean;
            result: import("./core/types").CompressionResult;
        }>("/api/compression/test", {
            method: "POST",
            body: JSON.stringify(body),
        });
        if (!res || !res.success) throw new Error("Compression failed");
        return res.result;
    }

    /**
     * Get compression engine statistics.
     */
    async getCompressionStats(): Promise<
        import("./core/types").CompressionStats
    > {
        const res = await this.request<{
            success: boolean;
            stats: import("./core/types").CompressionStats;
        }>("/api/compression/stats");
        return (
            res?.stats || {
                semanticCacheSize: 0,
                syntacticCacheSize: 0,
                totalCompressed: 0,
                cacheHitRate: "0%",
                algorithmStats: {
                    semantic: 0,
                    syntactic: 0,
                    aggressive: 0,
                    auto: 0,
                },
            }
        );
    }

    /**
     * Listen to real-time events (SSE).
     * Returns a cleanup function to close the stream.
     */
    listen(
        callback: (event: OpenMemoryEvent) => void,
        options: { subscribe?: "all" | string } = {},
    ): () => void {
        const controller = new AbortController();
        const signal = controller.signal;

        void (async () => {
            while (!signal.aborted) {
                try {
                    const headers: Record<string, string> = {
                        Accept: "text/event-stream",
                    };
                    if (this.token) {
                        headers["Authorization"] = `Bearer ${this.token}`;
                    }

                    const params = new URLSearchParams();
                    if (options.subscribe) params.append("subscribe", options.subscribe);

                    const response = await fetch(`${this.baseUrl}/stream?${params.toString()}`, {
                        headers,
                        signal,
                    });

                    if (!response.ok || !response.body) {
                        throw new Error(
                            `Failed to connect to stream: ${response.status}`,
                        );
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";

                    while (!signal.aborted) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split("\n\n");
                        buffer = lines.pop() || ""; // Keep incomplete chunk

                        for (const line of lines) {
                            if (line.startsWith("data: ")) {
                                try {
                                    const data = JSON.parse(line.slice(6));
                                    callback({
                                        type: data.type,
                                        data: data.data,
                                        timestamp: data.timestamp || Date.now(),
                                    });
                                } catch (e) {
                                    // ignore parse errors
                                }
                            }
                        }
                    }
                } catch (e: unknown) {
                    if (signal.aborted) return;
                    // Retry delay
                    await new Promise((r) => setTimeout(r, 5000));
                }
            }
        })();

        return () => controller.abort();
    }

    /**
     * Get a system-wide timeline of memory creation, aggregated by sector.
     * Useful for dashboards to visualize density over time.
     * 
     * @param hours Lookback period in hours
     * @param limit Max memories to fetch for aggregation (default 500)
     */
    async getSystemTimeline(hours = 24, limit = 500): Promise<SystemTimelineBucket[]> {
        // Fetch recent memories
        const memories = await this.list(limit);

        // Aggregate by hour
        const buckets: Record<string, { timestamp: number, counts: Record<string, number> }> = {};
        const now = Date.now();
        const cutoff = now - (hours * 60 * 60 * 1000);

        memories.forEach(m => {
            if (m.createdAt < cutoff) return;

            // Round to hour
            const date = new Date(m.createdAt);
            date.setMinutes(0, 0, 0);
            const key = date.toISOString();

            if (!buckets[key]) {
                buckets[key] = { timestamp: date.getTime(), counts: {} };
            }

            const sector = m.primarySector || "unknown";
            buckets[key].counts[sector] = (buckets[key].counts[sector] || 0) + 1;
        });

        // Convert to array and sort
        return Object.entries(buckets)
            .map(([key, data]) => ({
                bucket_key: key,
                timestamp_ms: data.timestamp,
                counts: data.counts
            }))
            .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    }
}

/**
 * Admin Client for OpenMemory.
 * Provides access to protected administrative routes (User, Key, Source Management).
 * Requires an Admin API Key.
 */
export class AdminClient extends MemoryClient {
    /**
     * Get all users.
     */
    async getUsers(): Promise<UserProfile[]> {
        const res = await this.request<{ users: UserProfile[] }>("/admin/users");
        return res?.users || [];
    }

    /**
     * Create or reactivate a user.
     */
    async createUser(userId: string, summary?: string): Promise<{ success: boolean; userId: string }> {
        return await this.request<{ success: boolean; userId: string }>("/admin/users", {
            method: "POST",
            body: JSON.stringify({ userId, summary }),
        });
    }

    /**
     * Delete a user and ALL their data.
     */
    async deleteUser(userId: string): Promise<{ success: boolean; userId: string }> {
        return await this.request<{ success: boolean; userId: string }>(`/admin/users/${userId}`, {
            method: "DELETE",
        });
    }

    /**
     * Get API keys for a user.
     */
    async getUserKeys(userId: string): Promise<{
        keyHash: string;
        role: string;
        note: string;
        createdAt: number;
        expiresAt: number;
    }[]> {
        const res = await this.request<{ keys: ApiKey[] }>(`/admin/users/${userId}/keys`);
        return res?.keys || [];
    }

    /**
     * Generate a new API key for a user.
     */
    async createKey(
        userId: string,
        role: "user" | "admin" | "read_only" = "user",
        note?: string,
        expiresInDays = 0
    ): Promise<{
        success: boolean;
        key: string;
        note?: string;
        expiresAt: number;
    }> {
        return await this.request<{
            success: boolean;
            key: string;
            note?: string;
            expiresAt: number;
        }>(`/admin/users/${userId}/keys`, {
            method: "POST",
            body: JSON.stringify({ role, note, expiresInDays }),
        });
    }

    /**
     * Revoke an API key by its hash.
     */
    async deleteKey(keyHash: string): Promise<{ success: boolean }> {
        return await this.request<{ success: boolean }>(`/admin/keys/${keyHash}`, {
            method: "DELETE",
        });
    }

    /**
     * Get source configurations for a user.
     */
    async getUserSources(userId: string): Promise<SourceRegistryEntry[]> {
        const res = await this.request<{ sources: SourceRegistryEntry[] }>(
            `/admin/users/${userId}/sources`
        );
        return res?.sources || [];
    }

    /**
     * Create or Update a source configuration for a user.
     */
    async createSource(
        userId: string,
        type: string,
        config: string | Record<string, unknown>,
        status: "enabled" | "disabled" = "enabled"
    ): Promise<{ success: boolean; type: string }> {
        const configStr = typeof config === "string" ? config : JSON.stringify(config);
        return await this.request<{ success: boolean; type: string }>(
            `/admin/users/${userId}/sources`,
            {
                method: "POST",
                body: JSON.stringify({ type, config: configStr, status }),
            }
        );
    }

    /**
     * Remove a source configuration for a user.
     */
    async deleteSource(userId: string, type: string): Promise<{ success: boolean }> {
        return await this.request<{ success: boolean }>(
            `/admin/users/${userId}/sources/${type}`,
            {
                method: "DELETE",
            }
        );
    }



    // --- Data Portability ---

    /**
     * Export all data (NDJSON stream).
     * @returns Blob or Text (Client-side usage). For Node.js, handle the stream manually from URL.
     */
    async exportData(): Promise<Blob> {
        // request() handles JSON by default. For export we need raw response.
        // But request() logic is JSON oriented.
        // We'll bypass request() for this specific stream download or use custom fetch.
        const headers: Record<string, string> = {};
        if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

        const res = await fetch(`${this.baseUrl}/admin/export`, { headers });
        if (!res.ok) throw new Error(`Export failed: ${res.status}`);
        return await res.blob();
    }

    /**
     * Import data (JSONL).
     */
    async importDatabase(data: string | object[]): Promise<{ success: boolean; users: number; memories: number; configs: number; errors: number }> {
        return await this.request<{ success: boolean; users: number; memories: number; configs: number; errors: number }>(
            "/admin/import",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: typeof data === "string" ? data : JSON.stringify(data),
            }
        );
    }

    /**
     * Get system metrics (Admin only).
     */
    async getSystemMetrics(): Promise<{ success: boolean; metrics: SystemMetrics }> {
        return await this.request<{ success: boolean; metrics: SystemMetrics }>("/system/metrics");
    }

    /**
     * Get dashboard overview statistics.
     */
    async getDashboardStats(): Promise<SystemStats> {
        return await this.request<SystemStats>("/dashboard/stats");
    }

    /**
     * Get graph context for a fact as an administrator.
     */
    async getGraphContext(
        factId: string,
        options?: { relationType?: string; at?: string | number; userId?: string },
    ): Promise<Array<{ fact: TemporalFact; relation: string; weight: number }>> {
        const params = new URLSearchParams({ factId });
        if (options?.relationType) params.append("relationType", options.relationType);
        if (options?.at) params.append("at", String(options.at));
        if (options?.userId) params.append("userId", options.userId);

        const res = await this.request<{
            results: Array<{ fact: TemporalFact; relation: string; weight: number }>;
        }>(`/temporal/graph-context?${params.toString()}`);
        return res?.results || [];
    }

    async train(userId?: string): Promise<{ success: boolean; version?: number; message?: string }> {
        const uid = userId || this.defaultUser;
        if (!uid) throw new Error("User ID required for training.");

        return await this.request<{ success: boolean; version?: number; message?: string }>(
            `/admin/users/${uid}/train`,
            { method: "POST" }
        );
    }
}
