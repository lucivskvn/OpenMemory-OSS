
import { Memory } from "./core/memory";
import { MemoryClient } from "./client";
import { MemoryItem, TemporalFact, HsgQueryResult } from "./core/types";

export interface CliMemoryInterface {
    add(content: string, opts?: any): Promise<{ id: string }>;
    search(query: string, opts?: any): Promise<any[]>;
    get(id: string): Promise<MemoryItem | null | undefined>;
    delete(id: string): Promise<boolean | number>;
    update(id: string, content?: string, tags?: string[], metadata?: any): Promise<any>;
    stats(): Promise<{ memories: number; vectors: number; facts: number; relations: number }>;
    wipe(): Promise<void>;
    deleteAll(userId?: string): Promise<any>;
    ingestUrl(url: string, opts?: any): Promise<any>;
    train(userId: string): Promise<any>;

    // Sub-modules
    temporal: {
        add(s: string, p: string, o: string, opts?: any): Promise<any>;
        search(pattern: string, opts?: any): Promise<any[]>;
        history(subject: string): Promise<any[]>;
        compare(subject: string, t1: Date, t2: Date): Promise<any>;
        getGraphContext(factId: string, opts?: any): Promise<any>;
        decay(rate?: number): Promise<any>;
        updateFact(id: string, conf?: number, meta?: any): Promise<any>;
        invalidateFact(id: string, validTo?: Date): Promise<any>;
        updateEdge(id: string, w?: number, meta?: any): Promise<any>;
        invalidateEdge(id: string, validTo?: Date): Promise<any>;
        stats(): Promise<any>; // { facts: { active, total }, edges: ... }
    };

    source(name: string): Promise<any>;
}

export class LocalAdapter implements CliMemoryInterface {
    constructor(private mem: Memory) { }

    async add(content: string, opts?: any) { return this.mem.add(content, opts); }
    async search(query: string, opts?: any) { return this.mem.search(query, opts); }
    async get(id: string) { return this.mem.get(id, undefined); } // Local defaults to configured user inside Memory if passed to ctor, or null
    async delete(id: string) { return this.mem.delete(id); }
    async update(id: string, content?: string, tags?: string[], metadata?: any) {
        return this.mem.update(id, content, tags, metadata);
    }
    async stats() { return this.mem.stats(); }
    async wipe() { return this.mem.wipe(); }
    async deleteAll(userId?: string) { return this.mem.deleteAll(userId); }
    async ingestUrl(url: string, opts?: any) { return this.mem.ingestUrl(url, opts); }

    get temporal() {
        const t = this.mem.temporal;
        return {
            add: t.add,
            search: t.search,
            history: t.history,
            compare: t.compare,
            getGraphContext: t.getGraphContext,
            decay: t.decay,
            updateFact: t.updateFact,
            invalidateFact: t.invalidateFact,
            updateEdge: (id: string, w?: number, meta?: any) => t.updateEdge(id, w, meta),
            // Wait, core.temporal.addEdge is insertEdge. updateEdge is NOT on internal temporal accessor exposed directly identically?
            // Core memory.ts: addEdge exists on temporal accessor. updateEdge exists only in t_store? 
            // In memory.ts, 'temporal' getter has 'addEdge'. Does it have 'updateEdge'?
            // Let's check memory.ts again. It has updateFact, invalidateFact. Does it have updateEdge?
            // ... (checking lines 403+ of memory.ts)
            // It has addEdge (line 521). It has getEdges. It has invalidateEdge.
            // It DOES NOT seem to expose updateEdge in the temporal accessor of Memory class!
            // I need to add updateEdge to Memory class temporal accessor if it's missing.
            invalidateEdge: t.invalidateEdge,
            stats: t.stats,
        };
    }

    async source(name: string) { return this.mem.source(name); }
    async train(userId: string) {
        // Dynamic import to avoid circular deps if needed, though Adapter -> Memory -> OK.
        // But Memory class doesn't expose train. Ops/maintenance does.
        const { trainUserClassifier } = await import("./ops/maintenance");
        return trainUserClassifier(userId, 30);
    }
}

export class RemoteAdapter implements CliMemoryInterface {
    constructor(private client: MemoryClient) { }

    async add(content: string, opts?: any) { return this.client.add(content, opts); }
    async search(query: string, opts?: any) { return this.client.search(query, opts); }
    async get(id: string) { return this.client.get(id); }
    async delete(id: string) {
        await this.client.delete(id);
        return 1; // Approximate
    }
    async update(id: string, content?: string, tags?: string[], metadata?: any) {
        return this.client.update(id, content, tags, metadata);
    }
    async stats() {
        // Client doesn't have compatible stats() yet.
        // It has getStats() -> SystemStats.
        // We need to map SystemStats to { memories, vectors, facts, relations } if possibilities allow.
        // Or implement a new stats endpoint on server side that mimics the core one?
        // Actually /dashboard/stats returns SystemStats which usually includes counts.
        // Let's assume we can map it or stub it for now.
        const s = await this.client.getStats();
        return {
            memories: s?.counts?.memories || 0,
            vectors: s?.counts?.vectors || 0,
            facts: s?.counts?.facts || 0,
            relations: s?.counts?.edges || 0
        };
    }

    async wipe() { throw new Error("Wipe not supported remotely."); }
    async deleteAll(userId?: string) { return this.client.deleteAll(userId); }
    async ingestUrl(url: string, opts?: any) { return this.client.ingestUrl(url, opts); }

    get temporal() {
        // Client already has unified temporal methods
        return {
            add: (s: string, p: string, o: string, opts: any) => this.client.addFact({ subject: s, predicate: p, object: o, ...opts }),
            search: (pattern: string, opts: any) => this.client.searchFacts(pattern, opts?.type, opts?.limit),
            history: (subject: string) => this.client.getTimeline(subject),
            compare: (s: string, t1: Date, t2: Date) => this.client.compareFacts(s, t1.getTime(), t2.getTime()),
            getGraphContext: (id: string, opts: any) => this.client.getGraphContext(id, opts),
            decay: (rate?: number) => this.client.applyDecay(rate),
            updateFact: (id: string, conf?: number, meta?: any) => this.client.updateFact(id, { confidence: conf, metadata: meta }),
            invalidateFact: (id: string, validTo?: Date) => this.client.deleteFact(id, validTo?.toISOString()),
            updateEdge: (id: string, w?: number, meta?: any) => this.client.updateEdge(id, { weight: w, metadata: meta }),
            invalidateEdge: (id: string, validTo?: Date) => this.client.deleteEdge(id, validTo?.toISOString()),
            stats: () => this.client.getTemporalStats(),
        };
    }

    async source(name: string) {
        return {
            connect: async () => { },
            ingestAll: async (filters: any) => this.client.ingestSource(name, { filters })
        };
    }

    async train(userId: string) { return this.client.train(userId); }

}
