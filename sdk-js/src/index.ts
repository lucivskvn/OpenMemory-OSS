import { randomUUID } from 'crypto';
import { hsg_query, classify_content, sector_configs, create_cross_sector_waypoints, calc_mean_vec, create_single_waypoint, reinforce_memory } from './memory/hsg';
import { embedMultiSector, vectorToBuffer } from './memory/embed';
import { q, init_db, log_maint_op, vector_store } from './core/db';
import { chunk_text } from './utils/chunking';
import { configure, env, tier } from './core/cfg';
import { ingestDocument, ingestURL, IngestionResult } from './ops/ingest';
import { update_user_summary } from './memory/user_summary';
import * as temporal from './memory/temporal';

export interface OpenMemoryOptions {
    mode?: 'local' | 'remote';
    path?: string;
    url?: string;
    apiKey?: string;
    embeddings?: {
        provider: 'openai' | 'gemini' | 'ollama' | 'aws' | 'local' | 'synthetic';
        apiKey?: string;
        model?: string;
        mode?: 'simple' | 'advanced';
        dimensions?: number;
        aws?: {
            accessKeyId?: string;
            secretAccessKey?: string;
            region?: string;
        };
        ollama?: {
            url?: string;
        };
        localPath?: string;
    };
    tier?: 'fast' | 'smart' | 'deep' | 'hybrid';
    compression?: {
        enabled: boolean;
        algorithm?: 'semantic' | 'syntactic' | 'aggressive' | 'auto';
        minLength?: number;
    };
    decay?: {
        intervalMinutes?: number;
        threads?: number;
        coldThreshold?: number;
        reinforceOnQuery?: boolean;
    };
    reflection?: {
        enabled: boolean;
        intervalMinutes?: number;
        minMemories?: number;
    };
    vectorStore?: {
        backend: 'sqlite' | 'pgvector' | 'weaviate';
    };
    langGraph?: {
        namespace?: string;
        maxContext?: number;
        reflective?: boolean;
    };
    telemetry?: boolean;
}

export class OpenMemory {
    private mode: 'local' | 'remote';
    private url?: string;
    private apiKey?: string;
    public temporal: any; // Using any to allow dynamic assignment of wrapper
    public langGraph: any;
    public compression: any;

    constructor(options: OpenMemoryOptions = {}) {
        this.mode = options.mode || 'local';
        this.url = options.url;
        this.apiKey = options.apiKey;

        // Initialize wrappers
        this.temporal = this._createTemporalWrapper();
        this.langGraph = this._createLangGraphWrapper();
        this.compression = this._createCompressionWrapper();

        if (this.mode === 'remote') {
            if (!this.url) throw new Error('Remote mode requires url parameter');
        } else {
            // Local mode configuration
            if (!options.path) {
                throw new Error('Local mode requires "path" configuration (e.g., "./data/memory.sqlite").');
            }
            if (!options.tier) {
                throw new Error('Local mode requires "tier" configuration (e.g., "fast", "smart", "deep", "hybrid").');
            }
            if (!options.embeddings) {
                throw new Error('Local mode requires embeddings configuration. Please specify a provider (e.g., openai, ollama, synthetic).');
            }

            const { provider, apiKey, aws } = options.embeddings;
            if (['openai', 'gemini'].includes(provider) && !apiKey) {
                throw new Error(`API key is required for ${provider} embeddings.`);
            }
            if (provider === 'aws' && (!aws || !aws.accessKeyId || !aws.secretAccessKey)) {
                throw new Error('AWS credentials (accessKeyId, secretAccessKey) are required for AWS embeddings.');
            }

            const configUpdate: any = {};

            configUpdate.db_path = options.path;
            configUpdate.tier = options.tier;

            configUpdate.emb_kind = options.embeddings.provider;
            if (options.embeddings.mode) configUpdate.embed_mode = options.embeddings.mode;
            if (options.embeddings.dimensions) configUpdate.vec_dim = options.embeddings.dimensions;

            if (options.embeddings.apiKey) {
                if (options.embeddings.provider === 'openai') configUpdate.openai_key = options.embeddings.apiKey;
                if (options.embeddings.provider === 'gemini') configUpdate.gemini_key = options.embeddings.apiKey;
            }
            if (options.embeddings.model) {
                if (options.embeddings.provider === 'openai') configUpdate.openai_model = options.embeddings.model;
            }
            if (options.embeddings.aws) {
                configUpdate.AWS_ACCESS_KEY_ID = options.embeddings.aws.accessKeyId;
                configUpdate.AWS_SECRET_ACCESS_KEY = options.embeddings.aws.secretAccessKey;
                configUpdate.AWS_REGION = options.embeddings.aws.region;
            }
            if (options.embeddings.ollama?.url) {
                configUpdate.ollama_url = options.embeddings.ollama.url;
            }
            if (options.embeddings.localPath) {
                configUpdate.local_model_path = options.embeddings.localPath;
            }

            if (options.compression) {
                configUpdate.compression_enabled = options.compression.enabled;
                if (options.compression.algorithm) configUpdate.compression_algorithm = options.compression.algorithm;
                if (options.compression.minLength) configUpdate.compression_min_length = options.compression.minLength;
            }

            if (options.decay) {
                if (options.decay.intervalMinutes) configUpdate.decay_interval_minutes = options.decay.intervalMinutes;
                if (options.decay.threads) configUpdate.decay_threads = options.decay.threads;
                if (options.decay.coldThreshold) configUpdate.decay_cold_threshold = options.decay.coldThreshold;
                if (options.decay.reinforceOnQuery !== undefined) configUpdate.decay_reinforce_on_query = options.decay.reinforceOnQuery;
            }

            if (options.reflection) {
                configUpdate.auto_reflect = options.reflection.enabled;
                if (options.reflection.intervalMinutes) configUpdate.reflect_interval = options.reflection.intervalMinutes;
                if (options.reflection.minMemories) configUpdate.reflect_min = options.reflection.minMemories;
            }

            if (options.vectorStore) {
                configUpdate.vector_backend = options.vectorStore.backend;
            }

            if (options.langGraph) {
                if (options.langGraph.namespace) configUpdate.lg_namespace = options.langGraph.namespace;
                if (options.langGraph.maxContext) configUpdate.lg_max_context = options.langGraph.maxContext;
                if (options.langGraph.reflective !== undefined) configUpdate.lg_reflective = options.langGraph.reflective;
            }

            configure(configUpdate);
            init_db(options.path);
        }
    }

    private _createTemporalWrapper() {
        return {
            create_fact: async (subject: string, predicate: string, object: string, valid_from?: number, valid_to?: number | null, confidence?: number, metadata?: any) => {
                if (this.mode === 'remote') {
                    const payload = { subject, predicate, object, valid_from, valid_to, confidence, metadata };
                    const res = await fetch(`${this.url}/api/temporal/fact`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) },
                        body: JSON.stringify(payload)
                    });
                    if (!res.ok) throw new Error(`Remote create_fact failed: ${res.status}`);
                    return (await res.json() as any).id;
                }
                return await temporal.create_fact(subject, predicate, object, valid_from, valid_to, confidence, metadata);
            },
            get_facts: async (filters: any) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams(filters as any);
                    const res = await fetch(`${this.url}/api/temporal/fact?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote get_facts failed: ${res.status}`);
                    return (await res.json() as any).facts;
                }
                return await temporal.get_facts(filters);
            },
            invalidate_fact: async (id: string, valid_to?: number) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams();
                    if (valid_to) params.append('valid_to', valid_to.toString());
                    const res = await fetch(`${this.url}/api/temporal/fact/${id}?${params}`, {
                        method: 'DELETE',
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote invalidate_fact failed: ${res.status}`);
                    return (await res.json() as any).ok;
                }
                return await temporal.invalidate_fact(id, valid_to);
            },
            create_edge: async (source_id: string, target_id: string, relation: string, weight?: number, metadata?: any) => {
                if (this.mode === 'remote') {
                    const payload = { source_id, target_id, relation, weight, metadata };
                    const res = await fetch(`${this.url}/api/temporal/edge`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) },
                        body: JSON.stringify(payload)
                    });
                    if (!res.ok) throw new Error(`Remote create_edge failed: ${res.status}`);
                    return (await res.json() as any).id;
                }
                return await temporal.create_edge(source_id, target_id, relation, weight, metadata);
            },
            get_edges: async (source_id: string) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams({ source_id });
                    const res = await fetch(`${this.url}/api/temporal/edge?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote get_edges failed: ${res.status}`);
                    return (await res.json() as any).edges;
                }
                return await temporal.get_edges(source_id);
            },
            get_related_facts: async (fact_id: string, relation_type?: string, at?: number) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams({ fact_id });
                    if (relation_type) params.append('relation_type', relation_type);
                    if (at) params.append('at', at.toString());
                    const res = await fetch(`${this.url}/api/temporal/related?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote get_related_facts failed: ${res.status}`);
                    return (await res.json() as any).related;
                }
                return await temporal.get_related_facts(fact_id, relation_type, at);
            },
            search_facts: async (pattern: string, field?: string, at?: number) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams({ pattern });
                    if (field) params.append('field', field);
                    if (at) params.append('at', at.toString());
                    const res = await fetch(`${this.url}/api/temporal/search?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote search_facts failed: ${res.status}`);
                    return (await res.json() as any).facts;
                }
                return await temporal.search_facts(pattern, field as any, at);
            },
            get_subject_timeline: async (subject: string, predicate?: string) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams({ subject });
                    if (predicate) params.append('predicate', predicate);
                    const res = await fetch(`${this.url}/api/temporal/timeline?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote get_subject_timeline failed: ${res.status}`);
                    return (await res.json() as any).timeline;
                }
                return await temporal.get_subject_timeline(subject, predicate);
            },
            get_changes_in_window: async (start: number, end: number, subject?: string) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams({ start: start.toString(), end: end.toString() });
                    if (subject) params.append('subject', subject);
                    const res = await fetch(`${this.url}/api/temporal/changes?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote get_changes_in_window failed: ${res.status}`);
                    return (await res.json() as any).timeline;
                }
                return await temporal.get_changes_in_window(start, end, subject);
            },
            get_change_frequency: async (subject: string, predicate: string, window_days?: number) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams({ subject, predicate });
                    if (window_days) params.append('window_days', window_days.toString());
                    const res = await fetch(`${this.url}/api/temporal/frequency?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote get_change_frequency failed: ${res.status}`);
                    return (await res.json() as any).result;
                }
                return await temporal.get_change_frequency(subject, predicate, window_days);
            },
            compare_time_points: async (subject: string, time1: number, time2: number) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams({ subject, time1: time1.toString(), time2: time2.toString() });
                    const res = await fetch(`${this.url}/api/temporal/compare?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote compare_time_points failed: ${res.status}`);
                    return (await res.json() as any).result;
                }
                return await temporal.compare_time_points(subject, time1, time2);
            },
            get_volatile_facts: async (subject?: string, limit?: number) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams();
                    if (subject) params.append('subject', subject);
                    if (limit) params.append('limit', limit.toString());
                    const res = await fetch(`${this.url}/api/temporal/volatile?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote get_volatile_facts failed: ${res.status}`);
                    return (await res.json() as any).result;
                }
                return await temporal.get_volatile_facts(subject, limit);
            }
        };
    }

    async add(content: string, options: {
        tags?: string[];
        metadata?: Record<string, any>;
        userId?: string;
        salience?: number;
        decayLambda?: number;
    } = {}): Promise<{ id: string; primarySector: string; sectors: string[] }> {
        if (this.mode === 'remote') {
            return this._remoteAdd(content, options);
        }

        const id = randomUUID();
        const now = Date.now();

        const classification = classify_content(content, options.metadata);
        const primary_sector = classification.primary;
        const sectors = [primary_sector, ...classification.additional];

        const chunks = content.length > 3000 ? chunk_text(content) : undefined;
        const embeddings = await embedMultiSector(id, content, sectors, chunks);
        const mean_vec = calc_mean_vec(embeddings, sectors);
        const mean_buf = vectorToBuffer(mean_vec);

        const tags_json = options.tags ? JSON.stringify(options.tags) : null;
        const meta_json = options.metadata ? JSON.stringify(options.metadata) : null;
        const salience = options.salience ?? 0.5;
        const decay_lambda = options.decayLambda ?? sector_configs[primary_sector].decay_lambda;

        await q.ins_mem.run(
            id, options.userId || null, 0, content, null, primary_sector,
            tags_json, meta_json, now, now, now, salience, decay_lambda, 1,
            mean_vec.length, mean_buf, null, 0
        );

        for (const emb of embeddings) {
            await vector_store.storeVector(id, emb.sector, emb.vector, emb.dim, options.userId);
        }

        if (classification.additional.length > 0) {
            await create_cross_sector_waypoints(id, primary_sector, classification.additional, options.userId);
        }

        await create_single_waypoint(id, mean_vec, now, options.userId);

        return { id, primarySector: primary_sector, sectors };
    }

    async query(query: string, options: {
        k?: number;
        userId?: string;
        filters?: {
            sectors?: string[];
            minSalience?: number;
            user_id?: string;
            startTime?: number;
            endTime?: number;
        };
    } = {}): Promise<any[]> {
        if (this.mode === 'remote') {
            return this._remoteQuery(query, options);
        }

        const filters = {
            ...options.filters,
            user_id: options.filters?.user_id || options.userId
        };

        return await hsg_query(query, options.k || 10, filters);
    }

    async delete(id: string): Promise<void> {
        if (this.mode === 'remote') {
            return this._remoteDelete(id);
        }

        await q.del_mem.run(id);
        await vector_store.deleteVectors(id);
        await q.del_waypoints.run(id, id);
    }

    async getAll(options: {
        limit?: number;
        offset?: number;
        sector?: string;
        userId?: string;
    } = {}): Promise<any[]> {
        if (this.mode === 'remote') {
            return this._remoteGetAll(options);
        }

        const limit = options.limit || 100;
        const offset = options.offset || 0;

        if (options.userId) {
            return await q.all_mem_by_user.all(options.userId, limit, offset);
        }
        if (options.sector) {
            return await q.all_mem_by_sector.all(options.sector, limit, offset);
        }
        return await q.all_mem.all(limit, offset);
    }

    async getUserSummary(userId: string): Promise<any> {
        if (this.mode === 'remote') {
            return this._remoteGetUserSummary(userId);
        }

        const user = await q.get_user.get(userId);
        return user ? {
            userId: user.user_id,
            summary: user.summary,
            reflectionCount: user.reflection_count,
            updatedAt: user.updated_at
        } : null;
    }

    async reinforce(id: string, boost?: number): Promise<void> {
        if (this.mode === 'remote') {
            return this._remoteReinforce(id, boost);
        }

        await reinforce_memory(id, boost);
    }

    async ingest(content: string | Buffer, options: {
        contentType: string;
        metadata?: any;
        userId?: string;
        config?: any;
    }): Promise<IngestionResult> {
        if (this.mode === 'remote') {
            return this._remoteIngest(content, options);
        }

        // Handle Buffer if passed
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
        // If content is string and contentType implies text, pass as string for extraction

        return await ingestDocument(
            options.contentType,
            content, // Types might need check, ingestDocument takes string | Buffer
            options.metadata,
            options.config,
            options.userId
        );
    }

    async ingestURL(url: string, options: {
        metadata?: any;
        userId?: string;
        config?: any;
    } = {}): Promise<IngestionResult> {
        if (this.mode === 'remote') {
            return this._remoteIngestURL(url, options);
        }

        return await ingestURL(url, options.metadata, options.config, options.userId);
    }

    async deleteUserMemories(userId: string): Promise<number> {
        if (this.mode === 'remote') {
            return this._remoteDeleteUserMemories(userId);
        }

        const mems = await q.all_mem_by_user.all(userId, 10000, 0);
        let deleted = 0;
        for (const m of mems) {
            await q.del_mem.run(m.id);
            await vector_store.deleteVectors(m.id);
            await q.del_waypoints.run(m.id, m.id);
            deleted++;
        }
        return deleted;
    }

    private _createLangGraphWrapper() {
        return {
            store: async (node: string, content: string, options: { namespace?: string; graphId?: string; tags?: string[]; metadata?: any; reflective?: boolean; userId?: string } = {}) => {
                if (this.mode === 'remote') {
                    const payload = { node, content, namespace: options.namespace, graph_id: options.graphId, tags: options.tags, metadata: options.metadata, reflective: options.reflective, user_id: options.userId };
                    const res = await fetch(`${this.url}/api/lg/store`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) },
                        body: JSON.stringify(payload)
                    });
                    if (!res.ok) throw new Error(`Remote LG store failed: ${res.status}`);
                    return await res.json();
                }
                const { store_node_mem } = await import('./ai/graph'); // Lazy import assuming local bundle has it?
                // Wait, sdk-js structure might not have ai/graph built-in for local mode if it relies on backend.
                // The prompt implies sdk-js maintains independent copies of core logic.
                // But does it have ai/graph?
                // backend/src/ai/graph.ts depends on hsg.ts.
                // sdk-js has memory/hsg.ts.
                // So I probably need to port graph.ts to sdk-js/src/ai/graph.ts or error on local.
                // For now, I'll error on local for LangGraph if it's not ported.
                // Checking file list...
                throw new Error("LangGraph local mode not fully implemented in SDK yet. Use remote mode.");
            },
            retrieve: async (node: string, options: { query?: string; namespace?: string; graphId?: string; limit?: number; userId?: string } = {}) => {
                if (this.mode === 'remote') {
                    const payload = { node, query: options.query, namespace: options.namespace, graph_id: options.graphId, limit: options.limit, user_id: options.userId };
                    const res = await fetch(`${this.url}/api/lg/retrieve`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) },
                        body: JSON.stringify(payload)
                    });
                    if (!res.ok) throw new Error(`Remote LG retrieve failed: ${res.status}`);
                    return await res.json();
                }
                throw new Error("LangGraph local mode not implemented.");
            },
            context: async (options: { namespace?: string; graphId?: string; limit?: number; userId?: string } = {}) => {
                if (this.mode === 'remote') {
                    const params = new URLSearchParams();
                    if (options.namespace) params.set('namespace', options.namespace);
                    if (options.graphId) params.set('graph_id', options.graphId);
                    if (options.limit) params.set('limit', options.limit.toString());
                    if (options.userId) params.set('user_id', options.userId);
                    const res = await fetch(`${this.url}/api/lg/context?${params}`, {
                        headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
                    });
                    if (!res.ok) throw new Error(`Remote LG context failed: ${res.status}`);
                    return await res.json();
                }
                throw new Error("LangGraph local mode not implemented.");
            }
        };
    }

    private _createCompressionWrapper() {
        return {
            compress: async (content: string) => {
                if (this.mode === 'remote') {
                    const res = await fetch(`${this.url}/api/compression/compress`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) },
                        body: JSON.stringify({ content })
                    });
                    if (!res.ok) throw new Error(`Remote compression failed: ${res.status}`);
                    return await res.json();
                }
                throw new Error("Compression local mode not implemented.");
            }
        };
    }

    private async _remoteAdd(content: string, options: any): Promise<any> {
        const { userId, decayLambda, ...rest } = options ?? {};

        const payload = {
            content,
            ...rest,
            user_id: userId,
            decay_lambda: decayLambda,
        };

        const res = await fetch(`${this.url}/api/memory/add`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`Remote add failed: ${res.status}`);
        return await res.json();
    }

    private async _remoteQuery(query: string, options: any): Promise<any[]> {
        const payload = {
            query,
            k: options.k,
            filters: options.filters,
            user_id: options.userId
        };

        const res = await fetch(`${this.url}/api/memory/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`Remote query failed: ${res.status}`);
        return await res.json() as any[];
    }

    private async _remoteDelete(id: string): Promise<void> {
        const res = await fetch(`${this.url}/api/memory/${id}`, {
            method: 'DELETE',
            headers: {
                ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            },
        });

        if (!res.ok) throw new Error(`Remote delete failed: ${res.status}`);
    }

    private async _remoteGetAll(options: any): Promise<any[]> {
        const params = new URLSearchParams();
        if (options.limit) params.set('limit', options.limit.toString());
        if (options.offset) params.set('offset', options.offset.toString());
        if (options.sector) params.set('sector', options.sector);
        if (options.userId) params.set('user_id', options.userId);

        const res = await fetch(`${this.url}/api/memory/all?${params}`, {
            headers: {
                ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            }
        });

        if (!res.ok) throw new Error(`Remote getAll failed: ${res.status}`);
        return await res.json() as any[];
    }

    private async _remoteGetUserSummary(userId: string): Promise<any> {
        const res = await fetch(`${this.url}/api/users/${userId}/summary`, {
            headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Remote getUserSummary failed: ${res.status}`);
        return await res.json();
    }

    private async _remoteReinforce(id: string, boost?: number): Promise<void> {
        const res = await fetch(`${this.url}/api/memory/reinforce`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            },
            body: JSON.stringify({ id, boost })
        });
        if (!res.ok) throw new Error(`Remote reinforce failed: ${res.status}`);
    }

    private async _remoteIngest(content: string | Buffer, options: any): Promise<any> {
        const payload = {
            data: content.toString('base64'), // Send as base64 assuming logic
            content_type: options.contentType,
            metadata: options.metadata,
            user_id: options.userId,
            config: options.config
        };
        const res = await fetch(`${this.url}/api/memory/ingest`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`Remote ingest failed: ${res.status}`);
        return await res.json();
    }

    private async _remoteIngestURL(url: string, options: any): Promise<any> {
        const payload = {
            url,
            metadata: options.metadata,
            user_id: options.userId,
            config: options.config
        };
        const res = await fetch(`${this.url}/api/memory/ingest/url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`Remote ingestURL failed: ${res.status}`);
        return await res.json();
    }

    private async _remoteDeleteUserMemories(userId: string): Promise<number> {
        const res = await fetch(`${this.url}/api/users/${userId}/memories`, {
            method: 'DELETE',
            headers: { ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }) }
        });
        if (!res.ok) throw new Error(`Remote deleteUserMemories failed: ${res.status}`);
        const json = await res.json() as any;
        return json.deleted;
    }
}

export { sector_configs, classify_content };
export default OpenMemory;
