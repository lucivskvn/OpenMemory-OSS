import { z } from "zod";
import { add_hsg_memory, hsg_query } from "../memory/hsg";
import { j } from "../utils";
import { insert_fact, invalidate_fact, insert_edge } from "../temporal_graph/store";
import { query_facts_at_time, query_edges } from "../temporal_graph/query";
import { get_subject_timeline } from "../temporal_graph/timeline";

/**
 * Standard schema for memory search
 */
export const SearchSchema = z.object({
    query: z.string().describe("The search query string"),
    limit: z.number().optional().default(5).describe("Max number of results"),
    user_id: z.string().optional().describe("User context/ID"),
});

/**
 * Standard schema for memory storage
 */
export const StoreSchema = z.object({
    content: z.string().describe("The memory content to store"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    user_id: z.string().optional().describe("User context/ID"),
});

export const TemporalFactSchema = z.object({
    subject: z.string(),
    predicate: z.string(),
    object: z.string(),
    valid_from: z.string().optional(),
    confidence: z.number().optional().default(1.0),
    user_id: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
});

/**
 * Generic Agent Tool definitions.
 * Designed to be framework-agnostic (works with LangChain, CrewAI, AutoGen).
 */
export class OpenMemoryTools {
    constructor(private default_user?: string) { }

    /**
     * Search for memories relevant to a query.
     */
    async search(query: string, limit = 5, user_id?: string) {
        const uid = user_id || this.default_user;
        const results = await hsg_query(query, limit, uid ? { user_id: uid } : undefined);
        return results.map(r => ({
            content: r.content,
            score: r.score,
            created: r.created_at,
            id: r.id
        }));
    }

    /**
     * Store important information to memory.
     */
    async store(content: string, tags: string[] = [], user_id?: string) {
        const uid = user_id || this.default_user;
        const res = await add_hsg_memory(content, j(tags), {}, uid ?? undefined);
        return {
            status: "success",
            id: res.id,
            sector: res.primary_sector
        };
    }

    /**
     * Query temporal state at a specific time.
     */
    async queryTemporalState(query: { subject?: string, predicate?: string, object?: string, at?: string, user_id?: string }) {
        const uid = query.user_id || this.default_user;
        const at_date = query.at ? new Date(query.at) : new Date();
        const results = await query_facts_at_time(query.subject, query.predicate, query.object, at_date, 0.1, uid ?? undefined);
        return results;
    }

    /**
     * Search for temporal facts by keyword.
     */
    async searchTemporalFacts(query: string, limit = 10, user_id?: string) {
        const uid = user_id || this.default_user;
        return await search_facts(query, limit, uid ?? undefined);
    }

    /**
     * Create a new temporal fact.
     */
    async storeTemporal(subject: string, predicate: string, object: string, confidence = 1.0, user_id?: string) {
        const uid = user_id || this.default_user;
        const id = await insert_fact(subject, predicate, object, new Date(), confidence, {}, uid ?? undefined);
        return { id, status: "success" };
    }

    /**
     * Get tool definitions for Function Calling (OpenAI/AutoGen style)
     */
    getFunctionDefinitions() {
        return [
            {
                name: "search_memory",
                description: "Search long-term episodic/semantic memory for relevant information using vector search.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "The query string" },
                        limit: { type: "integer", default: 5 },
                        user_id: { type: "string" }
                    },
                    required: ["query"]
                }
            },
            {
                name: "store_memory",
                description: "Save important information to long-term memory.",
                parameters: {
                    type: "object",
                    properties: {
                        content: { type: "string", description: "Information to save" },
                        tags: { type: "array", items: { type: "string" } },
                        user_id: { type: "string" }
                    },
                    required: ["content"]
                }
            },
            {
                name: "search_temporal_facts",
                description: "Search for specific knowledge facts in the temporal graph using keyword matching.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        limit: { type: "integer", default: 10 },
                        user_id: { type: "string" }
                    },
                    required: ["query"]
                }
            },
            {
                name: "query_temporal_state",
                description: "Query factual state at a specific point in time (time-travel query).",
                parameters: {
                    type: "object",
                    properties: {
                        subject: { type: "string" },
                        predicate: { type: "string" },
                        object: { type: "string" },
                        at: { type: "string", description: "ISO date string" },
                        user_id: { type: "string" }
                    }
                }
            },
            {
                name: "store_temporal_fact",
                description: "Store a structured fact into the temporal knowledge graph.",
                parameters: {
                    type: "object",
                    properties: {
                        subject: { type: "string" },
                        predicate: { type: "string" },
                        object: { type: "string" },
                        confidence: { type: "number", default: 1.0 },
                        user_id: { type: "string" }
                    },
                    required: ["subject", "predicate", "object"]
                }
            }
        ];
    }
}
