/**
 * @file client.ts
 * @description Main client facade for OpenMemory-JS.
 * @audited 2026-01-19
 */
import type {
    ActivityEntry,
    DynamicsConstants,
    CompressionResult,
    CompressionStats,
    IdeContextResult,
    IdePatternsResult,
    IdeSessionResult,
    IdeEventResult,
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
    MaintenanceStatus,
    MemoryItem,
    OpenMemoryEvent,
    ReinforcementResult,
    ResonanceResult,
    RetrievalResult,
    SalienceResult,
    SectorsResponse,
    SourceListResult,
    SourceRegistryEntry,
    ApiKey,
    SpreadingActivationResult,
    SystemMetrics,
    SystemStats,
    SystemTimelineBucket,
    TemporalComparisonResult,
    TemporalEdge,
    TemporalFact,
    TemporalStatsResult,
    TimelineEntry,
    TopMemory,
    UserMemoriesResult,
    UserProfile,
    ActivityItem,
    TimelineItem,
    UserSummary,
    VolatileFactsResult,
    WaypointGraphResult,
    WaypointWeightResult,
    HealthResponse,
    DashboardTimelineEntry,
    AddMemoryRequest,
} from "./core/types";

// Re-export core types
export * from "./core/types";

// Import Modular Clients
import { OpenMemoryError, ClientInterface } from "./clients/base";
export { OpenMemoryError };

import { TemporalClient } from "./clients/temporal";
import { LgmClient } from "./clients/lgm";
import { IdeClient } from "./clients/ide";
import { CompressionClient } from "./clients/compression";
import { DynamicsClient } from "./clients/dynamics";
import { AdminOpsClient } from "./clients/admin";
import { DashboardClient } from "./clients/dashboard";
import { SystemClient } from "./clients/system";
import { SourcesClient } from "./clients/sources";
import { EventsClient } from "./clients/events";
import { WebhooksClient } from "./clients/webhooks";

/**
 * Configuration for the MemoryClient.
 */
export interface MemoryClientConfig {
    /** The base URL of the OpenMemory server (e.g., "http://localhost:8080"). */
    baseUrl?: string;
    /** @deprecated Use `apiKey` instead. */
    token?: string;
    /** The API key for authentication. */
    apiKey?: string;
    /** The default user ID to use for requests if not specified. */
    defaultUser?: string;
}

export interface ClientMemoryOptions extends Partial<Omit<AddMemoryRequest, "content">> { }

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
 * const client = new MemoryClient({
 *   baseUrl: 'http://localhost:8000',
 *   apiKey: 'my-secret-key',
 *   defaultUser: 'user-123'
 * });
 *
 * // Add a memory
 * await client.add("Learned about TypeScript today", { tags: ['coding'] });
 *
 * // Search memories
 * const results = await client.search("TypeScript");
 * ```
 */
export class MemoryClient implements ClientInterface {
    protected baseUrl: string;
    public token?: string;
    public defaultUser?: string;

    constructor(config: MemoryClientConfig = {}) {
        this.baseUrl = (config.baseUrl || "http://localhost:8080").replace(
            /\/$/,
            "",
        );
        this.token = config.apiKey || config.token;
        this.defaultUser = config.defaultUser;
    }

    /**
     * Get the current API base URL.
     */
    public get apiBaseUrl(): string {
        return this.baseUrl;
    }

    // --- Sub-Clients (Namespaced APIs) ---

    /** Temporal Graph API sub-client */
    private _temporal?: TemporalClient;
    public get temporal(): TemporalClient {
        if (!this._temporal) this._temporal = new TemporalClient(this);
        return this._temporal;
    }

    /** LangGraph Memory (LGM) sub-client */
    private _lgm?: LgmClient;
    public get lgm(): LgmClient {
        if (!this._lgm) this._lgm = new LgmClient(this);
        return this._lgm;
    }

    /** IDE Integration sub-client */
    private _ide?: IdeClient;
    public get ide(): IdeClient {
        if (!this._ide) this._ide = new IdeClient(this);
        return this._ide;
    }

    /** Text Compression sub-client */
    private _compression?: CompressionClient;
    public get compression(): CompressionClient {
        if (!this._compression) this._compression = new CompressionClient(this);
        return this._compression;
    }

    /** Cognitive Dynamics sub-client */
    private _dynamics?: DynamicsClient;
    public get dynamics(): DynamicsClient {
        if (!this._dynamics) this._dynamics = new DynamicsClient(this);
        return this._dynamics;
    }

    /** Administrative Operations sub-client */
    private _admin?: AdminOpsClient;
    public get admin(): AdminOpsClient {
        if (!this._admin) this._admin = new AdminOpsClient(this);
        return this._admin;
    }

    /** Dashboard Operations sub-client */
    private _dashboard?: DashboardClient;
    public get dashboard(): DashboardClient {
        if (!this._dashboard) this._dashboard = new DashboardClient(this);
        return this._dashboard;
    }

    /** System Operations sub-client */
    private _system?: SystemClient;
    public get system(): SystemClient {
        if (!this._system) this._system = new SystemClient(this);
        return this._system;
    }

    /** External Source Connectors sub-client */
    private _sources?: SourcesClient;
    public get sources(): SourcesClient {
        if (!this._sources) this._sources = new SourcesClient(this);
        return this._sources;
    }

    /** Real-time Event Streaming sub-client */
    private _events?: EventsClient;
    public get events(): EventsClient {
        if (!this._events) this._events = new EventsClient(this);
        return this._events;
    }

    /** Webhook Management sub-client */
    private _webhooks?: WebhooksClient;
    public get webhooks(): WebhooksClient {
        if (!this._webhooks) this._webhooks = new WebhooksClient(this);
        return this._webhooks;
    }

    /**
     * Internal request helper.
     * @internal
     */
    public async request<T>(
        path: string,
        options: RequestInit & { skipJsonParse?: boolean; traceId?: string; spanId?: string; signal?: AbortSignal | null } = {},
    ): Promise<T> {
        const { retry } = await import("./utils/retry"); // Lazy import to avoid cycle

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
                    let json: any;
                    try {
                        json = JSON.parse(errText);
                        errText = json.error?.message || json.detail || json.message || errText;
                    } catch {
                        // Failed to parse error JSON
                    }

                    throw new OpenMemoryError(
                        errText,
                        res.status,
                        json?.error?.code || "SERVER_ERROR",
                        json
                    );
                }

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
                signal: options.signal || undefined,
                retries: (this as any).requestOptions?.retries ?? 3,
                shouldRetry: (err: any) => {
                    // Check by instanceof OR name (safer for bundled environments)
                    if (err instanceof OpenMemoryError || err?.name === "OpenMemoryError") {
                        const s = err.status;
                        // Don't retry on auth failures, not found, or bad requests
                        if (s === 401 || s === 403 || s === 404 || s === 400) return false;
                        return true;
                    }
                    if (err instanceof Error) {
                        if (err.name === "AbortError" || err.message.includes("aborted")) return false;
                    }
                    return true;
                },
            },
        );
    }

    /**
     * Checks the health status of the OpenMemory server.
     */
    async health(): Promise<boolean> {
        try {
            const res = await this.getHealth();
            return res.success;
        } catch {
            return false;
        }
    }

    /**
     * Returns detailed health information about the OpenMemory server.
     */
    async getHealth(): Promise<HealthResponse> {
        return await this.request<HealthResponse>("/health");
    }

    /**
     * Adds a new memory to the system.
     * 
     * @example
     * ```ts
     * const memory = await client.add("Meeting with engineering team about API design", {
     *   tags: ["work", "engineering"],
     *   metadata: { project: "OpenMemory" }
     * });
     * ```
     */
    async add(
        content: string,
        opts?: ClientMemoryOptions & { signal?: AbortSignal },
    ): Promise<MemoryItem> {
        const uid = opts?.userId || this.defaultUser || "anonymous";
        const tags = opts?.tags || [];
        const { id, createdAt, metadata, ...others } = opts || {};

        const combinedMetadata = { ...others, ...(metadata || {}) };

        const body: Record<string, unknown> = {
            content,
            userId: uid,
            tags,
            metadata: combinedMetadata,
        };

        if (id) body.id = id;
        if (createdAt) body.createdAt = createdAt;

        const res = await this.request<MemoryItem>("/memory/add", {
            method: "POST",
            body: JSON.stringify(body),
            signal: opts?.signal,
        });

        if (!res) throw new Error("Failed to add memory: Empty response");
        return res;
    }

    /**
     * Efficiently adds multiple memories in a single operation.
     */
    async addBatch(
        items: Array<{ content: string; tags?: string[]; metadata?: Record<string, unknown> }>,
        opts?: { userId?: string; signal?: AbortSignal },
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
            signal: opts?.signal,
        });
        return res?.items || [];
    }

    /**
     * Imports a memory with a specific ID and timestamp.
     */
    async importMemory(
        content: string,
        opts?: ClientMemoryOptions & { id?: string; createdAt?: number; signal?: AbortSignal },
    ): Promise<MemoryItem> {
        const uid = opts?.userId || this.defaultUser || "anonymous";
        const tags = opts?.tags || [];
        const { id, createdAt, metadata, ...others } = opts || {};

        const combinedMetadata = { ...others, ...(metadata || {}) };

        const body = {
            content,
            userId: uid,
            tags,
            metadata: combinedMetadata,
            id,
            createdAt,
        };

        const res = await this.request<MemoryItem>("/memory/add", {
            method: "POST",
            body: JSON.stringify(body),
            signal: opts?.signal,
        });

        if (!res) throw new Error("Failed to import memory: Empty response");
        return res;
    }

    /**
     * Performs a semantic (vector-based) search for relevant memories.
     *
     * @example
     * ```ts
     * const results = await client.search("project deadlines", {
     *   limit: 5,
     *   minSalience: 0.7
     * });
     * ```
     */
    async search(
        query: string,
        opts?: {
            userId?: string;
            limit?: number;
            minSalience?: number;
            sectors?: string[];
            tags?: string[];
            startTime?: number;
            endTime?: number;
            signal?: AbortSignal;
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
                sector: opts?.sectors?.[0],
                tags: opts?.tags,
                startTime: opts?.startTime,
                endTime: opts?.endTime,
            },
        };

        const res = await this.request<{ matches: MemoryItem[] }>(
            "/memory/query",
            {
                method: "POST",
                body: JSON.stringify(body),
                signal: opts?.signal,
            },
        );
        return res?.matches || [];
    }

    /**
     * Executes a keyword or semantic search for memories (Internal Alias).
     */
    async query(
        query: string,
        opts?: {
            userId?: string;
            limit?: number;
            minSalience?: number;
            sectors?: string[];
            tags?: string[];
            startTime?: number;
            endTime?: number;
            signal?: AbortSignal;
        },
    ): Promise<MemoryItem[]> {
        return this.search(query, opts);
    }

    /**
     * Retrieves a specific memory by its unique ID.
     */
    async get(id: string, options?: { userId?: string; signal?: AbortSignal }): Promise<MemoryItem | null> {
        const uid = options?.userId || this.defaultUser || undefined;
        const query = uid ? `?userId=${encodeURIComponent(uid)}` : "";
        try {
            return await this.request<MemoryItem>(`/memory/${id}${query}`, { signal: options?.signal });
        } catch (e: unknown) {
            if (e instanceof OpenMemoryError && e.status === 404) return null;
            if (e instanceof Error && e.message.includes("404")) return null;
            throw e;
        }
    }

    /**
     * Updates an existing memory's content or metadata.
     */
    async update(
        id: string,
        content?: string,
        tags?: string[],
        metadata?: Record<string, unknown>,
        options?: { userId?: string; signal?: AbortSignal }
    ): Promise<{ id: string; ok: boolean }> {
        const body: Record<string, unknown> = { id };
        if (content) body.content = content;
        if (tags) body.tags = tags;
        if (metadata) body.metadata = metadata;

        const uid = options?.userId || this.defaultUser || undefined;
        const query = uid ? `?userId=${encodeURIComponent(uid)}` : "";

        const res = await this.request<{ id: string; ok: boolean }>(
            `/memory/${id}${query}`,
            {
                method: "PATCH",
                body: JSON.stringify(body),
                signal: options?.signal,
            },
        );
        if (!res) throw new Error("Failed to update memory: Empty response");
        return res;
    }

    /**
     * Updates multiple memories in a single operation.
     */
    async updateBatch(
        items: Array<{ id: string; content?: string; tags?: string[]; metadata?: Record<string, unknown> }>,
        opts?: { userId?: string; signal?: AbortSignal },
    ): Promise<{ id: string; ok: boolean }[]> {
        const uid = opts?.userId || this.defaultUser || undefined;
        const res = await this.request<{ items: { id: string; ok: boolean }[] }>(
            "/memory/batch",
            {
                method: "PATCH",
                body: JSON.stringify({ items, userId: uid }),
                signal: opts?.signal,
            }
        );
        return res?.items || [];
    }

    /**
     * Deletes a memory from the system.
     */
    async delete(id: string, options?: { userId?: string; signal?: AbortSignal }): Promise<boolean> {
        const uid = options?.userId || this.defaultUser || undefined;
        const query = uid ? `?userId=${encodeURIComponent(uid)}` : "";
        await this.request(`/memory/${id}${query}`, { method: "DELETE", signal: options?.signal });
        return true;
    }

    /**
     * Deletes multiple memories by ID (Bulk operation).
     */
    async deleteBatch(ids: string[], options?: { userId?: string; signal?: AbortSignal }): Promise<void> {
        const uid = options?.userId || this.defaultUser || undefined;
        const query = uid ? `?userId=${encodeURIComponent(uid)}` : "";
        await this.request(`/memory/batch/delete${query}`, {
            method: "POST",
            body: JSON.stringify({ ids }),
            signal: options?.signal,
        });
    }

    /**
     * @deprecated Use deleteBatch instead.
     */
    async deleteMany(ids: string[], options?: { signal?: AbortSignal }): Promise<void> {
        return this.deleteBatch(ids, options);
    }

    /**
     * Retrieves a paginated list of all memories for a user.
     */
    async list(
        limit = 100,
        offset = 0,
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<MemoryItem[]> {
        const uid = userId || this.defaultUser || undefined;
        const params = new URLSearchParams({
            l: limit.toString(),
            u: offset.toString(),
        });
        if (uid) params.append("userId", uid);

        const res = await this.request<{ items: MemoryItem[] }>(
            `/memory/all?${params.toString()}`,
            { signal: options?.signal }
        );
        return res?.items || [];
    }

    /**
     * Reinforces a memory's importance, preventing it from decaying.
     */
    /**
     * Reinforces a memory's importance, preventing it from decaying.
     */
    async reinforce(id: string, boost = 0.1, options?: { userId?: string; signal?: AbortSignal }): Promise<boolean> {
        const uid = options?.userId || this.defaultUser || undefined;
        const query = uid ? `?userId=${encodeURIComponent(uid)}` : "";
        await this.request(`/memory/${id}/reinforce${query}`, {
            method: "POST",
            body: JSON.stringify({ boost }),
            signal: options?.signal,
        });
        return true;
    }

    /**
     * Ingests content from a public URL.
     */
    async ingestUrl(
        url: string,
        options?: {
            userId?: string;
            metadata?: Record<string, unknown>;
            config?: IngestionConfig;
            signal?: AbortSignal;
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
            signal: options?.signal,
        });
        if (!res) throw new Error("Ingestion failed: Empty response");
        return res;
    }

    /**
     * Ingests a raw document (text/buffer) or structured request.
     */
    async ingest<T = unknown>(
        contentTypeOrRequest:
            | string
            | (Omit<AddMemoryRequest, "content"> & {
                source?: string;
                contentType: string;
                data: T;
                config?: IngestionConfig;
            }),
        data?: string | T,
        options?: {
            userId?: string;
            metadata?: Record<string, unknown>;
            config?: IngestionConfig;
            signal?: AbortSignal;
        },
    ): Promise<IngestionResult> {
        let contentType: string;
        let pData: string | T;
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
            pData = data as string | T;
        }

        const uid = pOptions.userId || this.defaultUser || "anonymous";
        const source = (typeof contentTypeOrRequest === "object" ? (contentTypeOrRequest as any).source : null) || "file";

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
            signal: options?.signal,
        });
        if (!res) throw new Error("Ingestion failed: Empty response");
        return res;
    }

    /**
     * Delete all user memories.
     */
    async deleteUserMemories(
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<{ success: boolean; deletedCount: number }> {
        const uid = userId || this.defaultUser;
        const params = new URLSearchParams();
        if (uid) params.append("userId", uid);

        const res = await this.request<{
            ok: boolean;
            success?: boolean;
            deleted: number;
            deletedCount?: number;
        }>(`/memory/all?${params.toString()}`, { method: "DELETE", signal: options?.signal });

        return {
            success: res.ok ?? res.success ?? true,
            deletedCount: res.deleted ?? res.deletedCount ?? 0
        };
    }

    /**
     * Get a timeline of system activity.
     */
    async getSystemTimeline(hours = 24, limit = 500, options?: { signal?: AbortSignal }): Promise<SystemTimelineBucket[]> {
        const memories = await this.list(limit, 0, undefined, { signal: options?.signal });
        const buckets: Record<string, { timestamp: number, counts: Record<string, number> }> = {};
        const now = Date.now();
        const cutoff = now - (hours * 60 * 60 * 1000);

        memories.forEach(m => {
            if (m.createdAt < cutoff) return;
            const date = new Date(m.createdAt);
            date.setMinutes(0, 0, 0);
            const key = date.toISOString();

            if (!buckets[key]) {
                buckets[key] = { timestamp: date.getTime(), counts: {} };
            }

            const sector = m.primarySector || "unknown";
            buckets[key].counts[sector] = (buckets[key].counts[sector] || 0) + 1;
        });

        return Object.entries(buckets)
            .map(([key, data]) => ({
                bucketKey: key,
                timestampMs: data.timestamp,
                counts: data.counts
            }))
            .sort((a, b) => a.timestampMs - b.timestampMs);
    }

    /**
     * Checker if the system is in Setup Mode.
     */
    async getSetupStatus(options?: { signal?: AbortSignal }): Promise<{ setupMode: boolean; message: string }> {
        return await this.request<{ setupMode: boolean; message: string }>("/setup/status", { signal: options?.signal });
    }

    /**
     * Verify setup token and create root Admin.
     */
    async performSetup(
        token: string,
        userId: string,
        options?: { signal?: AbortSignal }
    ): Promise<{ success: boolean; apiKey: string; userId: string; role: string }> {
        return await this.request("/setup/verify", {
            method: "POST",
            body: JSON.stringify({ token, userId }),
            signal: options?.signal,
        });
    }

    // --- Sub-Client Delegations (Backward Compatibility) ---

    // Temporal Graph API
    /** @deprecated Use client.temporal.addFact */
    async addFact(fact: { subject: string; predicate: string; object: string; validFrom?: string | number; confidence?: number; metadata?: Record<string, unknown> }, userId?: string, options?: { signal?: AbortSignal }) { return this.temporal.addFact(fact, userId, options); }
    /** @deprecated Use client.temporal.updateFact */
    async updateFact(id: string, updates: { confidence?: number; metadata?: Record<string, unknown> }, options?: { signal?: AbortSignal }) { return this.temporal.updateFact(id, updates, options); }
    /** @deprecated Use client.temporal.deleteFact */
    async deleteFact(id: string, validTo?: string | number, options?: { signal?: AbortSignal }) { return this.temporal.deleteFact(id, validTo, options); }
    /** @deprecated Use client.temporal.getFacts */
    async getFacts(query: { subject?: string; predicate?: string; object?: string; at?: string | number; minConfidence?: number; signal?: AbortSignal; userId?: string }) { return this.temporal.getFacts(query); }
    /** @deprecated Use client.temporal.searchFacts */
    async searchFacts(pattern: string, type: "subject" | "predicate" | "object" | "all" = "all", limit = 100, options?: { signal?: AbortSignal; userId?: string }) { return this.temporal.searchFacts(pattern, type, limit, options); }
    /** @deprecated Use client.temporal.getTimeline */
    async getTimeline(subject: string, predicate?: string, options?: { signal?: AbortSignal; userId?: string }) { return this.temporal.getTimeline(subject, predicate, options); }
    /** @deprecated Use client.temporal.addEdge */
    async addEdge(edge: { sourceId: string; targetId: string; relationType: string; validFrom?: string | number; weight?: number; metadata?: Record<string, unknown> }, userId?: string, options?: { signal?: AbortSignal }) { return this.temporal.addEdge(edge, userId, options); }
    /** @deprecated Use client.temporal.updateEdge */
    async updateEdge(id: string, updates: { weight?: number; metadata?: Record<string, unknown> }, options?: { signal?: AbortSignal }) { return this.temporal.updateEdge(id, updates, options); }
    /** @deprecated Use client.temporal.deleteEdge */
    async deleteEdge(id: string, validTo?: string | number, options?: { signal?: AbortSignal }) { return this.temporal.deleteEdge(id, validTo, options); }
    /** @deprecated Use client.temporal.getEdges */
    async getEdges(query: { sourceId?: string; targetId?: string; relationType?: string; at?: string | number; limit?: number; offset?: number; signal?: AbortSignal; userId?: string }) { return this.temporal.getEdges(query); }
    /** @deprecated Use client.temporal.getCurrentFact */
    async getCurrentFact(subject: string, predicate: string, at?: string | number, options?: { signal?: AbortSignal; userId?: string }) { return this.temporal.getCurrentFact(subject, predicate, at, options); }
    /** @deprecated Use client.temporal.getPredicateHistory */
    async getPredicateHistory(p: string, f?: string | number, t?: string | number, o?: { signal?: AbortSignal; userId?: string }) { return this.temporal.getPredicateHistory(p, f, t, o); }
    /** @deprecated Use client.temporal.getSubjectFacts */
    async getSubjectFacts(s: string, a?: string | number, i = false, o?: { signal?: AbortSignal; userId?: string }) { return this.temporal.getSubjectFacts(s, a, i, o); }
    /** @deprecated Use client.temporal.compareFacts */
    async compareFacts(s: string, t1: string | number, t2: string | number, o?: { signal?: AbortSignal; userId?: string }) { return this.temporal.compareFacts(s, t1, t2, o); }
    /** @deprecated Use client.temporal.getStats */
    async getTemporalStats(o?: { signal?: AbortSignal; userId?: string }) { return this.temporal.getStats(o); }
    /** @deprecated Use client.temporal.applyDecay */
    async applyDecay(r?: number, u?: string, o?: { signal?: AbortSignal }) { return this.temporal.applyDecay(r, u, o); }
    /** @deprecated Use client.temporal.getVolatileFacts */
    async getVolatileFacts(s?: string, l?: number, u?: string, o?: { signal?: AbortSignal }) { return this.temporal.getVolatileFacts(s, l, u, o); }

    // LangGraph Memory (LGM) API
    /** @deprecated Use client.lgm.store */
    async lgStore(req: LgmStoreRequest | { node: string; content: string;[key: string]: unknown }, options?: { signal?: AbortSignal }) { return this.lgm.store(req as any, options); }
    /** @deprecated Use client.lgm.retrieve */
    async lgRetrieve(req: LgmRetrieveRequest | { node: string;[key: string]: unknown }, options?: { signal?: AbortSignal }) { return this.lgm.retrieve(req as any, options); }
    /** @deprecated Use client.lgm.getContext */
    async lgContext(req: LgmContextRequest | { node: string;[key: string]: unknown }, options?: { signal?: AbortSignal }) { return this.lgm.getContext(req as any, options); }
    /** @deprecated Use client.lgm.reflect */
    async lgReflect(req: LgmReflectionRequest | { node: string; graphId?: string;[key: string]: unknown }, options?: { signal?: AbortSignal }) { return this.lgm.reflect(req as any, options); }
    /** @deprecated Use client.lgm.getConfig */
    async getLgConfig(options?: { signal?: AbortSignal }) { return this.lgm.getConfig(options); }

    // IDE Integration API
    /** @deprecated Use client.ide.startSession */
    async startIdeSession(opts: { ide: string; version?: string; workspace?: string; userId?: string; metadata?: Record<string, unknown>; signal?: AbortSignal }) { return this.ide.startSession(opts); }
    /** @deprecated Use client.ide.endSession */
    async endIdeSession(sessionId: string, options?: { signal?: AbortSignal }) { return this.ide.endSession(sessionId, options); }
    /** @deprecated Use client.ide.sendEvent */
    async sendIdeEvent(event: { sessionId: string; eventType: string; filePath?: string; content?: string; metadata?: Record<string, unknown>; userId?: string; language?: string; signal?: AbortSignal }) { return this.ide.sendEvent(event); }
    /** @deprecated Use client.ide.getContext */
    async getIdeContext(sessionId: string, file: string, line?: number, options?: { signal?: AbortSignal }) { return this.ide.getContext(sessionId, file, line, options); }
    /** @deprecated Use client.ide.getPatterns */
    async getIdePatterns(sessionId: string, options?: { signal?: AbortSignal }) { return this.ide.getPatterns(sessionId, options); }

    // Compression API
    async compressText(text: string, algorithm: "semantic" | "syntactic" | "aggressive" = "semantic", options?: { signal?: AbortSignal }) {
        const res = await this.compression.compress(text, algorithm, undefined, options);
        return {
            originalSize: res.originalSize || 0,
            compressedSize: res.compressedSize || 0,
            ratio: res.metrics?.ratio || res.ratio || 0,
            data: res.comp || res.memoryId // fallback logic
        };
    }
    async getCompressionStats(options?: { signal?: AbortSignal }) { return this.compression.getStats(options); }

    // Dynamics API
    /** @deprecated Use client.dynamics.getConstants */
    async getDynamicsConstants(o?: { signal?: AbortSignal }) { return this.dynamics.getConstants(o); }
    /** @deprecated Use client.dynamics.calculateSalience */
    async calculateSalience(p: {
        initialSalience?: number;
        decayLambda?: number;
        recallCount?: number;
        emotionalFrequency?: number;
        timeElapsedDays?: number;
        signal?: AbortSignal;
    }) { return this.dynamics.calculateSalience(p); }
    /** @deprecated Use client.dynamics.calculateResonance */
    async calculateResonance(p: {
        memorySector?: string;
        querySector?: string;
        baseSimilarity?: number;
        signal?: AbortSignal;
    }) { return this.dynamics.calculateResonance(p); }
    /** @deprecated Use client.dynamics.retrieveEnergyBased */
    async retrieveEnergyBased(p: {
        query: string;
        sector?: string;
        minEnergy?: number;
        signal?: AbortSignal;
    }) { return this.dynamics.retrieveEnergyBased(p); }
    /** @deprecated Use client.dynamics.reinforceTrace */
    async reinforceTrace(id: string, o?: { signal?: AbortSignal }) { return this.dynamics.reinforceTrace(id, undefined, o); }
    /** @deprecated Use client.dynamics.spreadingActivation */
    async spreadingActivation(ids: string[], m?: number, o?: { signal?: AbortSignal }) { return this.dynamics.spreadingActivation(ids, m, undefined, o); }
    /** @deprecated Use client.dynamics.getWaypointGraph */
    async getWaypointGraph(l?: number, o?: { signal?: AbortSignal }) { return this.dynamics.getWaypointGraph(l, undefined, o); }
    /** @deprecated Use client.dynamics.calculateWaypointWeight */
    async calculateWaypointWeight(s: string, t: string, o?: { signal?: AbortSignal }) { return this.dynamics.calculateWaypointWeight(s, t, undefined, o); }

    // Admin & Dashboard (Delegated)
    /** @deprecated Use client.admin.getUsers */
    async getUsers(o?: { signal?: AbortSignal }) { return this.admin.getUsers(o); }
    /** @deprecated Use client.admin.getUsers */
    async listUsers(o?: { signal?: AbortSignal }) { return this.admin.getUsers(o); }
    /** @deprecated Use client.admin.getUser */
    async getUser(id: string, o?: { signal?: AbortSignal }) { return this.admin.getUser(id, o); }
    /** @deprecated Use client.admin.createUser */
    async createUser(id: string, s?: string, o?: { signal?: AbortSignal }) { return this.admin.createUser(id, s, o); }
    /** @deprecated Use client.admin.deleteUser */
    async deleteUser(id: string, o?: { signal?: AbortSignal }) { return this.admin.deleteUser(id, o); }
    /** @deprecated Use client.admin.getAuditLogs */
    async getAuditLogs(o?: import("./core/types/admin").AuditLogParams) { return this.admin.getAuditLogs(o); }
    /** @deprecated Use client.admin.getUserKeys */
    async getUserKeys(id: string, o?: { signal?: AbortSignal }) { return this.admin.getUserKeys(id, o); }
    /** @deprecated Use client.admin.createKey */
    async createKey(id: string, r: string = "user", n?: string, e = 0, o?: { signal?: AbortSignal }) { return this.admin.createKey(id, r, n, e, o); }
    /** @deprecated Use client.admin.deleteKey */
    async deleteKey(h: string, o?: { signal?: AbortSignal }) { return this.admin.deleteKey(h, o); }

    async getStats(o?: { signal?: AbortSignal }) { return this.dashboard.getStats(undefined, o); }
    async getMaintenanceStatus(o?: { signal?: AbortSignal }) { return this.system.getMaintenanceStatus(o); }
    async getSectors(o?: { signal?: AbortSignal }) { return this.system.getSectors(o); }
    async getActivity(l = 50, o?: { signal?: AbortSignal }) { return this.dashboard.getActivity(l, undefined, o); }
    async getTopMemories(l = 10, o?: { signal?: AbortSignal }) { return this.dashboard.getTopMemories(l, undefined, o); }

    /** @deprecated Use client.admin.train */
    async train(u?: string, o?: Record<string, unknown>) { return this.admin.train({ userId: u, ...o } as any); }
    /** @deprecated Use client.events.listen */
    listen(c: (event: import("./core/types").OpenMemoryEvent) => void, o: { subscribe?: "all" | string } = {}) { return this.events.listen(c, o); }

    /** Alias for temporal.getTimeline */
    async timeline(s: string, p?: string) { return this.temporal.getTimeline(s, p); }
    /** Alias for compression.compress */
    async compress(t: string, a?: "semantic" | "syntactic" | "aggressive", o?: { signal?: AbortSignal }) { return this.compression.compress(t, a, undefined, o); }
}

/**
 * Admin Client for OpenMemory.
 * @audited 2026-01-19
 */
export class AdminClient extends MemoryClient {
    private _security?: SecurityClient;
    public get security(): SecurityClient {
        if (!this._security) this._security = new SecurityClient(this);
        return this._security;
    }
}

/**
 * Dedicated Client for Security Operations.
 * @audited 2026-01-19
 */
export class SecurityClient {
    constructor(private client: MemoryClient) { }
    async getAuditLogs(f?: import("./core/types/admin").AuditLogParams) { return this.client.admin.getAuditLogs(f); }
    async getAuditStats(o?: { signal?: AbortSignal }) { return this.client.admin.getAuditStats(o); }
    async purgeAuditLogs(b: number, o?: { signal?: AbortSignal }) { return this.client.admin.purgeAuditLogs(b, o); }
    async listWebhooks(o?: { signal?: AbortSignal }) { return this.client.webhooks.list(undefined, o); }
    async createWebhook(u: string, e: string[], s?: string, uid?: string, o?: { signal?: AbortSignal }) {
        return this.client.webhooks.create(u, e, s, uid, o);
    }
    async testWebhook(id: string, o?: { signal?: AbortSignal }) { return this.client.webhooks.test(id, undefined, o); }
    async deleteWebhook(id: string, o?: { signal?: AbortSignal }) { return this.client.webhooks.delete(id, undefined, o); }
}
