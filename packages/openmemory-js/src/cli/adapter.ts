
import { Memory } from "../core/memory";
import { MemoryClient } from "../client";
import { MemoryItem, TemporalFact, HsgQueryResult } from "../core/types";
import { HealthResponse, SystemMetrics, MaintenanceStatus, SectorsResponse, MaintLogEntry } from "../core/types/system";

export interface CliMemoryInterface {
    add(content: string, opts?: { tags?: string[]; metadata?: Record<string, unknown>; userId?: string }): Promise<MemoryItem>;
    search(query: string, opts?: { limit?: number; userId?: string }): Promise<MemoryItem[]>;
    get(id: string): Promise<MemoryItem | null | undefined>;
    delete(id: string): Promise<boolean | number>;
    update(id: string, content?: string, tags?: string[], metadata?: Record<string, unknown>): Promise<boolean>;
    stats(): Promise<{ memories: number; vectors: number; facts: number; relations: number }>;
    wipe(): Promise<void>;
    deleteAll(userId?: string): Promise<number>;
    ingestUrl(url: string, opts?: { userId?: string; metadata?: Record<string, unknown> }): Promise<boolean>;
    ingest(contentType: string, data: unknown, opts?: { userId?: string; metadata?: Record<string, unknown> }): Promise<boolean>;
    train(userId: string): Promise<boolean>;

    // Sub-modules
    temporal: {
        add(s: string, p: string, o: string, opts?: { confidence?: number; metadata?: Record<string, unknown> }): Promise<TemporalFact>;
        search(pattern: string, opts?: { type?: "subject" | "predicate" | "object"; limit?: number }): Promise<TemporalFact[]>;
        history(subject: string): Promise<any[]>; // TimelineEntry[] if imported
        compare(subject: string, t1: Date, t2: Date): Promise<any>;
        getGraphContext(factId: string, opts?: { relationType?: string; at?: Date }): Promise<any>;
        decay(rate?: number): Promise<number>;
        updateFact(id: string, conf?: number, meta?: Record<string, unknown>): Promise<boolean>;
        invalidateFact(id: string, validTo?: Date): Promise<boolean>;
        updateEdge(id: string, w?: number, meta?: Record<string, unknown>): Promise<boolean>;
        invalidateEdge(id: string, validTo?: Date): Promise<boolean>;
        stats(): Promise<{ facts: { total: number; active: number }; edges: { total: number; active: number } }>;
    };

    system: {
        getHealth(): Promise<HealthResponse>;
        getMetrics(): Promise<{ success: boolean; metrics: SystemMetrics }>;
        getMaintenanceStatus(): Promise<MaintenanceStatus>;
        getSectors(): Promise<SectorsResponse>;
        getLogs(limit?: number, userId?: string): Promise<{ success: boolean; logs: MaintLogEntry[] }>;
    };

    source(name: string): Promise<{ connect(): Promise<void>; ingestAll(filters?: Record<string, unknown>): Promise<boolean> }>;
}

export class LocalAdapter implements CliMemoryInterface {
    constructor(private mem: Memory) { }

    async add(content: string, opts?: { tags?: string[]; metadata?: Record<string, unknown>; userId?: string }) {
        const res = await this.mem.add(content, opts);
        return res;
    }
    async search(query: string, opts?: { limit?: number; userId?: string }) {
        return this.mem.search(query, opts);
    }
    async get(id: string) { return this.mem.get(id, undefined); }
    async delete(id: string) { return this.mem.delete(id); }
    async update(id: string, content?: string, tags?: string[], metadata?: Record<string, unknown>) {
        const res = await this.mem.update(id, { content, tags, metadata });
        return !!res;
    }
    async stats() {
        const s = await this.mem.stats();
        return {
            memories: s.memories,
            vectors: s.vectors,
            facts: s.facts,
            relations: s.relations
        };
    }
    async wipe() { await this.mem.wipe(); }
    async deleteAll(userId?: string) { return this.mem.deleteAll(userId); }
    async ingestUrl(url: string, opts?: { userId?: string; metadata?: Record<string, unknown> }) {
        const res = await this.mem.ingestUrl(url, opts);
        return !!res;
    }
    async ingest(contentType: string, data: unknown, opts?: { userId?: string; metadata?: Record<string, unknown> }) {
        const res = await this.mem.ingest({
            contentType,
            data,
            userId: opts?.userId,
            metadata: opts?.metadata,
            source: opts?.metadata?.sourceFile ? 'file' : 'cli'
        } as any);
        return !!res;
    }

    get temporal() {
        const t = this.mem.temporal;
        if (!t) throw new Error("Temporal module not initialized");
        return {
            add: (s: string, p: string, o: string, opts?: { confidence?: number; metadata?: Record<string, unknown> }) =>
                this.mem.temporal!.add(s, p, o, opts) as unknown as Promise<TemporalFact>,
            search: async (pattern: string, opts?: { type?: "subject" | "predicate" | "object"; limit?: number }) => {
                return await t.search(pattern, { type: opts?.type as any, limit: opts?.limit });
            },
            history: t.history,
            compare: t.compare,
            getGraphContext: t.getGraphContext,
            decay: t.decay,
            updateFact: (id: string, conf?: number, meta?: Record<string, unknown>) =>
                t.updateFact(id, conf, meta),
            invalidateFact: t.invalidateFact,
            updateEdge: (id: string, w?: number, meta?: Record<string, unknown>) =>
                t.updateEdge(id, w, meta),
            invalidateEdge: t.invalidateEdge,
            stats: t.stats,
        };
    }

    get system() {
        return {
            getHealth: async () => ({ success: true, status: "ok", version: "local", timestamp: Date.now() } as HealthResponse),
            getMetrics: async () => ({ success: true, metrics: { memory: {}, cpu: {}, uptime: process.uptime(), version: "local" } } as any),
            getMaintenanceStatus: async () => ({ success: true, active_jobs: [], count: 0 } as any),
            getSectors: async () => ({ sectors: [], configs: {}, stats: [] } as SectorsResponse),
            getLogs: async (limit = 100, userId?: string) => {
                const { q } = await import("../core/db");
                const logs = await q.getMaintenanceLogs.all(limit, userId);
                return { success: true, logs: logs as MaintLogEntry[] };
            }
        };
    }

    async source(name: string) {
        const s = await this.mem.source(name);
        return {
            connect: async () => { await s.connect(); },
            ingestAll: async (filters?: Record<string, unknown>) => {
                const res = await s.ingestAll(filters);
                return !!res;
            }
        };
    }
    async train(userId: string) {
        const { trainUserClassifier } = await import("../ops/maintenance");
        await trainUserClassifier(userId, 30);
        return true;
    }
}

export class RemoteAdapter implements CliMemoryInterface {
    constructor(private client: MemoryClient) { }

    async add(content: string, opts?: { tags?: string[]; metadata?: Record<string, unknown>; userId?: string }) {
        return this.client.add(content, opts);
    }
    async search(query: string, opts?: { limit?: number; userId?: string }) {
        return this.client.search(query, opts);
    }
    async get(id: string) { return this.client.get(id); }
    async delete(id: string) {
        await this.client.delete(id);
        return 1;
    }
    async update(id: string, content?: string, tags?: string[], metadata?: Record<string, unknown>) {
        const res = await this.client.update(id, content, tags, metadata);
        return !!res;
    }
    async stats() {
        const s = await this.client.getStats();
        if (!s) return { memories: 0, vectors: 0, facts: 0, relations: 0 };
        return {
            memories: s.counts.memories,
            vectors: s.counts.vectors,
            facts: s.counts.facts,
            relations: s.counts.edges
        };
    }

    async wipe() {
        await this.client.deleteUserMemories(undefined);
    }
    async deleteAll(userId?: string) {
        const res = await this.client.deleteUserMemories(userId);
        return res.deletedCount;
    }
    async ingestUrl(url: string, opts?: { userId?: string; metadata?: Record<string, unknown> }) {
        const res = await this.client.ingestUrl(url, opts);
        return !!res;
    }
    async ingest(contentType: string, data: unknown, opts?: { userId?: string; metadata?: Record<string, unknown> }) {
        const res = await this.client.ingest({
            contentType,
            data,
            userId: opts?.userId,
            metadata: opts?.metadata
        } as any);
        return !!res;
    }

    get temporal() {
        return {
            add: async (s: string, p: string, o: string, opts?: { confidence?: number; metadata?: Record<string, unknown> }) => {
                const res = await this.client.temporal.addFact({ subject: s, predicate: p, object: o, ...opts });
                return res as unknown as TemporalFact;
            },
            search: async (pattern: string, opts?: { type?: "subject" | "predicate" | "object"; limit?: number }) => {
                return await this.client.temporal.searchFacts(pattern, opts?.type as any, opts?.limit);
            },
            history: (subject: string) => this.client.temporal.getTimeline(subject),
            compare: (s: string, t1: Date, t2: Date) => this.client.temporal.compareFacts(s, t1.getTime(), t2.getTime()),
            getGraphContext: (id: string, opts?: { relationType?: string; at?: Date }) =>
                this.client.temporal.getGraphContext(id, opts ? { ...opts, at: opts.at?.getTime() } : undefined),
            decay: async (rate?: number) => {
                const res = await this.client.temporal.applyDecay(rate);
                return res.factsUpdated;
            },
            updateFact: async (id: string, conf?: number, meta?: Record<string, unknown>) => {
                const res = await this.client.temporal.updateFact(id, { confidence: conf, metadata: meta });
                return !!res;
            },
            invalidateFact: async (id: string, validTo?: Date) => {
                const res = await this.client.temporal.deleteFact(id, validTo?.getTime());
                return !!res;
            },
            updateEdge: async (id: string, w?: number, meta?: Record<string, unknown>) => {
                const res = await this.client.temporal.updateEdge(id, { weight: w, metadata: meta });
                return !!res;
            },
            invalidateEdge: async (id: string, validTo?: Date) => {
                const res = await this.client.temporal.deleteEdge(id, validTo?.getTime());
                return !!res;
            },
            stats: async () => {
                const s = await this.client.temporal.getStats();
                return {
                    facts: { total: s.totalFacts, active: s.activeFacts },
                    edges: { total: 0, active: 0 }
                };
            },
        };
    }

    get system() {
        return {
            getHealth: () => this.client.system.getHealth(),
            getMetrics: () => this.client.system.getMetrics(),
            getMaintenanceStatus: () => this.client.system.getMaintenanceStatus(),
            getSectors: () => this.client.system.getSectors(),
            getLogs: (limit?: number, userId?: string) => this.client.system.getLogs(limit, userId)
        };
    }

    async source(name: string) {
        return {
            connect: async () => { },
            ingestAll: async (filters: any) => {
                const res = await this.client.sources.ingest({
                    contentType: 'application/json',
                    data: JSON.stringify({ name, filters }),
                    source: name
                });
                return !!res;
            }
        };
    }

    async train(userId: string) {
        const res = await this.client.admin.train({ userId, dataType: 'all' });
        return !!res;
    }

}
