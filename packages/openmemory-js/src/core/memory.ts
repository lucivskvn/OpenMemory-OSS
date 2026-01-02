import {
    add_hsg_memory,
    hsg_query,
    reinforce_memory,
    update_memory,
} from "../memory/hsg";
import * as t_store from "../temporal_graph/store";
import * as t_query from "../temporal_graph/query";
import { TemporalFact } from "../temporal_graph/types";
import { ingestDocument, ingestURL } from "../ops/ingest";
import { MemoryItem, mem_row, ingest_req, ingest_url_req, HsgQueryResult } from "./types";
import { q, log_maint_op } from "./db";
import { env } from "./cfg";
import { get_encryption } from "./security";
import { j, p } from "../utils";
import { compressionEngine } from "../ops/compress";

export interface MemoryOptions {
    user_id?: string;
    tags?: string[];
    [key: string]: unknown;
}

export const parse_mem = async (m: mem_row): Promise<MemoryItem> => {
    const enc = get_encryption();
    return {
        ...m,
        content: await enc.decrypt(m.content),
        tags: m.tags ? p(m.tags) : [],
        meta: m.meta ? p(m.meta) : {},
    };
};

export class Memory {
    default_user: string | null;

    constructor(user_id?: string) {
        this.default_user = user_id || null;
    }

    /**
     * Add a new memory with automated classification and embedding.
     * @param content The text content to remember
     * @param opts Metadata, tags, and user context
     * @returns The created memory record
     */
    async add(content: string, opts?: MemoryOptions) {
        const uid = opts?.user_id || this.default_user;
        const tags = opts?.tags || [];
        const meta: Record<string, unknown> = { ...opts };
        delete meta.user_id;
        delete meta.tags;

        const tags_str = JSON.stringify(tags);

        // Encryption is handled inside add_hsg_memory for consistency with embeddings
        const res = await add_hsg_memory(content, tags_str, meta, uid ?? undefined);
        // Consistency: Return the full MemoryItem
        return (await this.get(res.id))!;
    }

    /**
     * Ingest a document from raw data (PDF, text, etc.).
     * @param options Ingestion options (content_type, data, metadata)
     */
    async ingest(options: Omit<ingest_req, "source"> & { source?: string }) {
        const uid = options.user_id || this.default_user;
        return await ingestDocument(
            options.content_type,
            options.data,
            options.metadata,
            options.config,
            uid ?? undefined
        );
    }

    /**
     * Ingest content from a URL.
     * @param url The URL to scrape/process
     * @param options Metadata and config
     */
    async ingestURL(url: string, options?: Omit<ingest_url_req, "url">) {
        const uid = options?.user_id || this.default_user;
        return await ingestURL(
            url,
            options?.metadata,
            options?.config,
            uid ?? undefined
        );
    }

    /**
     * Reinforce a memory (increase salience).
     * @param id Memory ID
     * @param boost Amount to boost (default based on implementation)
     */
    async reinforce(id: string, boost?: number) {
        const uid = this.default_user || undefined;
        await reinforce_memory(id, boost, uid);
        return { ok: true };
    }

    /**
     * Update an existing memory.
     * @param id Memory ID
     * @param content New content (optional)
     * @param tags New tags (optional)
     * @param metadata New metadata (optional)
     */
    async update(id: string, content?: string, tags?: string[], metadata?: Record<string, any>) {
        const uid = this.default_user || undefined;
        // Check existence first as per route logic?
        // simple wrapper around update_memory which checks implicitly or explicitly
        const res = await update_memory(id, content, tags, metadata, uid);
        return res;
    }

    /**
     * Retrieve a memory by ID.
     * Enforces user ownership if a user context is set.
     * @param id The memory ID
     * @returns The memory record or undefined if not found/unauthorized
     */
    async get(id: string): Promise<MemoryItem | undefined> {
        const row = await q.get_mem.get(id, this.default_user ?? undefined);
        return row ? await parse_mem(row as unknown as mem_row) : undefined;
    }

    /**
     * Delete a memory by ID.
     * @param id The memory ID
     */
    async delete(id: string) {
        const uid = this.default_user || undefined;
        return await q.del_mem.run(id, uid);
    }

    /**
     * List all memories for the current user with pagination.
     * @param limit Maximum number of records to return
     * @param offset Number of records to skip
     * @returns List of memory records
     */
    async list(limit = 100, offset = 0): Promise<MemoryItem[]> {
        const uid = this.default_user;
        let rows: mem_row[];
        if (!uid) {
            rows = (await q.all_mem.all(limit, offset)) as unknown as mem_row[];
        } else {
            rows = (await q.all_mem_by_user.all(uid, limit, offset)) as unknown as mem_row[];
        }
        return await Promise.all(rows.map(parse_mem));
    }

    /**
     * Search memories using hybrid semantic and keyword retrieval.
     * @param query The search query
     * @param opts Search limits and filters
     * @returns Ranked list of matching memories
     */
    async search(query: string, opts?: { user_id?: string, limit?: number, sectors?: string[] }) {
        const k = opts?.limit || 10;
        const uid = opts?.user_id || this.default_user;
        const f: { user_id?: string; sectors?: string[] } = {};
        if (uid) f.user_id = uid;
        if (opts?.sectors) f.sectors = opts.sectors;

        // hsg_query returns hsg_q_result[], which handles decryption internally
        return await hsg_query(query, k, f);
    }

    /**
     * Delete all memories for the current user.
     * Requires a user context (default_user or passed argument) to prevent accidental data loss.
     * @param user_id Optional user ID override
     */
    async delete_all(user_id?: string) {
        const uid = user_id || this.default_user;
        if (uid) {
            // Secure user-scoped wipe
            await q.del_mem_by_user.run(uid);
        } else {
            console.warn("[Memory] delete_all called without user_id. Ignoring to prevent accidental global wipe.");
            // If we really want global wipe, use administrative tool or explicit flag, 
            // but for 'Client' usage, safety first.
        }
    }

    /**
     * List all unique user IDs in the system.
     * Useful for administrative or backup tasks.
     * @returns List of user IDs
     */
    async list_users() {
        const res = await q.get_active_users.all();
        return res.map(u => u.user_id);
    }

    /**
     * @deprecated Use delete_all() with specific user_id context.
     * This method wipes the ENTIRE database and should only be used for testing.
     */
    async wipe() {
        if (process.env.NODE_ENV !== "test") {
            console.warn("[Memory] wipe() called in non-test environment! This destroys ALL data.");
        }
        console.log("[Memory] Wiping DB...");
        await q.clear_all.run();
    }

    /**
     * Access Temporal Graph Memory features.
     * Allows storing and querying facts with valid-time history.
     */
    get temporal() {
        const uid = this.default_user;
        return {
            /**
             * Insert a new fact into the temporal graph.
             */
            add: async (
                subject: string,
                predicate: string,
                object: string,
                opts?: { valid_from?: Date; confidence?: number; metadata?: Record<string, any> }
            ) => {
                return await t_store.insert_fact(
                    subject,
                    predicate,
                    object,
                    opts?.valid_from,
                    opts?.confidence,
                    opts?.metadata,
                    uid ?? undefined
                );
            },

            /**
             * Get the current valid fact for a subject-predicate pair.
             */
            get: async (subject: string, predicate: string) => {
                return await t_query.get_current_fact(subject, predicate, uid ?? undefined);
            },

            /**
             * Search for facts matching a pattern.
             */
            search: async (
                pattern: string,
                opts?: { field?: 'subject' | 'predicate' | 'object'; at?: Date; limit?: number }
            ) => {
                return await t_query.search_facts(
                    pattern,
                    opts?.field,
                    opts?.at,
                    opts?.limit || 100,
                    uid ?? undefined
                );
            },

            /**
             * Get the history of a subject.
             */
            history: async (subject: string, include_historical = true) => {
                return await t_query.get_facts_by_subject(subject, undefined, include_historical, uid ?? undefined);
            },

            /**
             * Create a temporal relationship between two facts/entities.
             */
            add_edge: async (source_id: string, target_id: string, relation_type: string, opts?: { weight?: number, valid_from?: Date, metadata?: Record<string, any> }) => {
                return await t_store.insert_edge(source_id, target_id, relation_type, opts?.valid_from, opts?.weight, opts?.metadata, uid ?? undefined);
            },

            /**
             * Get edges related to a fact or entity.
             */
            get_edges: async (source_id?: string, target_id?: string, relation?: string, at?: Date) => {
                return await t_query.query_edges(source_id, target_id, relation, at, uid ?? undefined);
            }
        };
    }

    /**
     * Access Compression Engine features.
     * Optimize text storage and analyze token usage.
     */
    get compression() {
        // Dynamic import to avoid circular deps if any, though compress is usually standalone
        const { compressionEngine } = require("../ops/compress");
        // Note: checking if require is available or use import(). 
        // mixed ES/CommonJS might be tricky in Bun, but require usually works if not strict ESM only.
        // Actually, we are using import in this file. Let's use a lazy object or import at top if safe.
        // compress.ts is likely safe. Let's try regular import at top?
        // But the instruction is to replace here. 
        // Let's assume we can add import at top in next step or use dynamic import which returns promise?
        // But getters must be synchronous usually or return an async API.
        // Let's return a proxy or object that calls the engine.

        return {
            compress: (text: string, algorithm?: "semantic" | "syntactic" | "aggressive") => {
                return compressionEngine.compress(text, algorithm);
            },
            batch: (texts: string[], algorithm?: "semantic" | "syntactic" | "aggressive") => {
                return compressionEngine.batch(texts, algorithm);
            },
            analyze: (text: string) => {
                return compressionEngine.analyze(text);
            },
            stats: () => {
                return compressionEngine.getStats();
            },
            reset: () => {
                compressionEngine.reset();
                compressionEngine.clear();
            }
        };
    }

    /**
     * get a pre-configured source connector.
     * 
     * usage:
     *   const github = mem.source("github")
     *   await github.connect({ token: "ghp_..." })
     *   await github.ingest_all({ repo: "owner/repo" })
     * 
     * available sources: github, notion, google_drive, google_sheets, 
     *                   google_slides, onedrive, web_crawler
     */
    source(name: string) {
        // dynamic import to avoid circular deps
        const sources: Record<string, any> = {
            github: () => import("../sources/github").then(m => new m.github_source(this.default_user ?? undefined)),
            notion: () => import("../sources/notion").then(m => new m.notion_source(this.default_user ?? undefined)),
            google_drive: () => import("../sources/google_drive").then(m => new m.google_drive_source(this.default_user ?? undefined)),
            google_sheets: () => import("../sources/google_sheets").then(m => new m.google_sheets_source(this.default_user ?? undefined)),
            google_slides: () => import("../sources/google_slides").then(m => new m.google_slides_source(this.default_user ?? undefined)),
            onedrive: () => import("../sources/onedrive").then(m => new m.onedrive_source(this.default_user ?? undefined)),
            web_crawler: () => import("../sources/web_crawler").then(m => new m.web_crawler_source(this.default_user ?? undefined)),
        };

        if (!(name in sources)) {
            throw new Error(`unknown source: ${name}. available: ${Object.keys(sources).join(", ")}`);
        }

        return sources[name]();
    }
}
