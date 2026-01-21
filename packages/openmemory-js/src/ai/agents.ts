/**
 * @file agents.ts
 * @description Standalone toolset for Agent integrations.
 * @audited 2026-01-19
 */
import { Memory } from "../core/memory";
import { AppError } from "../server/errors";
import { env } from "../core/cfg";
import { normalizeUserId, safeDate } from "../utils";

/**
 * Generic Agent Tool definitions.
 * Designed to be framework-agnostic (works with LangChain, CrewAI, AutoGen, and custom agents).
 * Provides a standardized interface for agents to interact with long-term memory and the temporal knowledge graph.
 */
export class OpenMemoryTools {
    /**
     * Initializes the toolset with an optional default user context.
     * @param defaultUserId Optional user identifier used if not provided in individual tool calls.
     */
    private defaultUserId?: string | null;
    private memory: Memory;

    constructor(defaultUserId?: string | null) {
        this.defaultUserId = normalizeUserId(defaultUserId);
        this.memory = new Memory(this.defaultUserId);
    }

    /**
     * Search for memories relevant to a query using semantic vector search.
     * @param query The search query string.
     * @param limit Maximum number of results to return (default: 5).
     * @param userId Optional user ID to scope the search.
     */
    async search(
        query: string,
        limit = 10,
        userId?: string | null,
    ): Promise<
        { content: string; score: number; created: number; id: string }[]
    > {
        if (!query || typeof query !== "string")
            throw new AppError(
                400,
                "BAD_REQUEST",
                "Query must be a non-empty string",
            );

        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(
                400,
                "BAD_REQUEST",
                "User ID is required for Agent operations to prevent data leakage.",
            );

        const m = finalUserId ? new Memory(finalUserId) : this.memory;
        const results = await m.search(query, { limit });
        return results.map((r) => ({
            content: r.content,
            score: r.score,
            created: r.createdAt,
            id: r.id,
        }));
    }

    /**
     * Store important information to the Hyper Semantic Graph (HSG).
     * @param content The information/text to remember.
     * @param tags Array of tags for categorization.
     * @param userId Optional user ID to associate with the memory.
     */
    async store(
        content: string,
        tags: string[] = [],
        userId?: string | null,
    ): Promise<{ status: string; id: string; sector: string }> {
        if (!content || typeof content !== "string")
            throw new AppError(
                400,
                "BAD_REQUEST",
                "Content must be a non-empty string",
            );

        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const m = finalUserId ? new Memory(finalUserId) : this.memory;
        const res = await m.add(content, { tags });

        return {
            status: "success",
            id: res.id,
            sector: res.primarySector,
        };
    }

    /**
     * Query factual temporal state at a specific point in time.
     * @param query Object containing optional subject, predicate, object, and timestamp filters.
     */
    async queryTemporalState(query: {
        subject?: string;
        predicate?: string;
        object?: string;
        at?: string | number;
        userId?: string | null;
    }): Promise<import("../temporal_graph/types").TemporalFact[]> {
        const finalUserId = normalizeUserId(query.userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const atDate = safeDate(query.at) || new Date();
        const m = finalUserId ? new Memory(finalUserId) : this.memory;

        return await m.temporal.queryFacts(
            query.subject,
            query.predicate,
            query.object,
            atDate,
            0.1,
        );
    }

    /**
     * Search for temporal facts using keyword matching across all components (S, P, O).
     * @param query The search keyword.
     * @param limit Maximum number of facts to return.
     * @param userId Optional user ID scope.
     */
    async searchTemporalFacts(
        query: string,
        limit = 10,
        userId?: string | null,
    ): Promise<import("../temporal_graph/types").TemporalFact[]> {
        if (!query) throw new AppError(400, "BAD_REQUEST", "Query is required");
        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const m = finalUserId ? new Memory(finalUserId) : this.memory;
        return await m.temporal.search(query, { limit });
    }

    /**
     * Store a structured fact into the temporal knowledge graph.
     * @param subject The entity being described.
     * @param predicate The relationship or attribute.
     * @param object The value or related entity.
     * @param confidence Confidence score (0.0 to 1.0).
     * @param validFrom Optional ISO date string or timestamp.
     * @param metadata Optional additional properties.
     * @param userId Optional user ID scope.
     */
    async storeTemporal(
        subject: string,
        predicate: string,
        object: string,
        confidence = 1.0,
        validFrom?: string | number,
        metadata: Record<string, unknown> = {},
        userId?: string | null,
    ): Promise<{ id: string; status: string }> {
        if (!subject || !predicate || !object)
            throw new AppError(
                400,
                "BAD_REQUEST",
                "Subject, predicate, and object are required",
            );

        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const from = safeDate(validFrom) || new Date();
        const m = finalUserId ? new Memory(finalUserId) : this.memory;
        const id = await m.temporal.add(subject, predicate, object, {
            validFrom: from,
            confidence,
            metadata,
        });
        return { id, status: "success" };
    }

    /**
     * Update an existing temporal fact (confidence, metadata, or corrections).
     * @param factId The UUID of the fact to update.
     * @param confidence Optional new confidence score.
     * @param metadata Optional new metadata (merged).
     * @param userId Optional user ID scope.
     */
    async updateTemporalFact(
        factId: string,
        confidence?: number,
        metadata?: Record<string, unknown>,
        userId?: string | null,
    ): Promise<{ status: string; factId: string }> {
        if (!factId)
            throw new AppError(400, "BAD_REQUEST", "Fact ID is required");

        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const m = finalUserId ? new Memory(finalUserId) : this.memory;
        await m.temporal.updateFact(factId, confidence, metadata);
        return { status: "success", factId };
    }

    /**
     * Invalidate (soft-delete) a temporal fact at a specific time.
     * @param factId The UUID of the fact to invalidate.
     * @param validTo Optional ISO date string or timestamp (defaults to now).
     * @param userId Optional user ID scope.
     */
    async invalidateTemporal(
        factId: string,
        validTo?: string | number,
        userId?: string | null,
    ): Promise<{ status: string; factId: string; invalidatedAt: string }> {
        if (!factId)
            throw new AppError(400, "BAD_REQUEST", "Fact ID is required");
        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const toDate = safeDate(validTo) || new Date();
        const m = finalUserId ? new Memory(finalUserId) : this.memory;
        await m.temporal.invalidateFact(factId, toDate);
        return {
            status: "success",
            factId,
            invalidatedAt: toDate.toISOString(),
        };
    }

    /**
     * Store a non-temporal relation (edge) between entities.
     * @param source Source entity ID.
     * @param target Target entity ID.
     * @param relation Relation type.
     * @param weight Edge weight (default: 1.0).
     * @param userId Optional user ID scope.
     */
    async storeTemporalEdge(
        source: string,
        target: string,
        relationType: string,
        weight = 1.0,
        metadata?: Record<string, unknown>,
        userId?: string | null,
    ): Promise<{ id: string; status: string }> {
        if (!source || !target || !relationType)
            throw new AppError(
                400,
                "BAD_REQUEST",
                "Source, target, and relationType are required",
            );
        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const m = finalUserId ? new Memory(finalUserId) : this.memory;
        const id = await m.temporal.addEdge(source, target, relationType, {
            weight,
            metadata,
        });
        return { id, status: "success" };
    }

    /**
     * Update an existing temporal edge (weight or metadata).
     * @param edgeId The UUID of the edge to update.
     * @param weight Optional new weight.
     * @param metadata Optional new metadata (merged).
     * @param userId Optional user ID scope.
     */
    async updateTemporalEdge(
        edgeId: string,
        weight?: number,
        metadata?: Record<string, unknown>,
        userId?: string | null,
    ): Promise<{ status: string; edgeId: string }> {
        if (!edgeId) throw new AppError(400, "BAD_REQUEST", "Edge ID is required");

        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const m = finalUserId ? new Memory(finalUserId) : this.memory;
        await m.temporal.updateEdge?.(edgeId, weight, metadata);

        return { status: "success", edgeId };
    }

    /**
     * Summarize a block of text using the system's compression engine.
     * Useful for agents to condense their own history or context.
     * @param content The text to summarize.
     */
    async summarize(content: string) {
        if (!content)
            throw new AppError(400, "BAD_REQUEST", "Content is required");
        // Dynamically import to avoid circular dependency if agents.ts is used in core
        const { compressionEngine } = await import("../ops/compress");
        const result = await compressionEngine.compress(content, "semantic");
        return result.comp;
    }

    /**
     * Store memory associated with a specific cognitive node (LangGraph style).
     * Automatically handles sector resolution and optional reflection.
     * @param node Node name (e.g., perceive, plan, act).
     * @param content The observation or result to store.
     * @param namespace Cognitive namespace (default: 'default').
     * @param graphId Optional thread/graph ID.
     * @param userId Optional user ID context.
     */
    async storeNodeMemory(
        node: string,
        content: string,
        namespace = "default",
        graphId?: string,
        userId?: string,
    ) {
        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const { storeNodeMem } = await import("./graph");
        return await storeNodeMem({
            node,
            content,
            namespace,
            graphId,
            userId: finalUserId || undefined,
        });
    }

    /**
     * Get a summarized cognitive context for the current execution thread.
     * Aggregates memories from across all nodes in the graph namespace.
     * @param namespace Cognitive namespace (default: 'default').
     * @param graphId Optional thread/graph ID.
     * @param limit Max items to synthesize.
     * @param userId Optional user ID context.
     */
    async getGraphContext(
        namespace = "default",
        graphId?: string,
        limit = 20,
        userId?: string,
    ) {
        const finalUserId = normalizeUserId(userId) || this.defaultUserId;
        if (!finalUserId && !env.noAuth)
            throw new AppError(400, "BAD_REQUEST", "User ID is required.");

        const { getGraphCtx } = await import("./graph");
        return await getGraphCtx({
            namespace,
            graphId,
            limit,
            userId: finalUserId || undefined,
        });
    }

    /**
     * Get tool definitions for Function Calling (OpenAI/AutoGen style).
     * Useful for initializing agents with memory capabilities.
     * Uses Zod schemas for consistent parameter validation.
     */
    getFunctionDefinitions() {
        const userIdRequired = !this.defaultUserId;
        const baseRequired = (req: string[]) =>
            userIdRequired ? [...req, "userId"] : req;

        return [
            {
                name: "search_memory",
                description:
                    "Search long-term episodic/semantic memory for relevant information using semantic vector search.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The query string to search for.",
                        },
                        limit: {
                            type: "integer",
                            description: "Maximum results to return.",
                            default: 10,
                        },
                        userId: {
                            type: "string",
                            description:
                                "Optional user ID to scope the search.",
                        },
                    },
                    required: baseRequired(["query"]),
                },
            },
            {
                name: "store_memory",
                description:
                    "Save important information, insights, or experiences to long-term memory for later recall.",
                parameters: {
                    type: "object",
                    properties: {
                        content: {
                            type: "string",
                            description: "The text content to remember.",
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional tags for categorization.",
                        },
                        userId: {
                            type: "string",
                            description:
                                "Optional user ID to associate with the memory.",
                        },
                    },
                    required: baseRequired(["content"]),
                },
            },
            {
                name: "search_temporal_facts",
                description:
                    "Search for specific factual knowledge (triplets) in the temporal graph using keyword matching.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Keyword to search for in facts.",
                        },
                        limit: { type: "integer", default: 10 },
                        userId: { type: "string" },
                    },
                    required: baseRequired(["query"]),
                },
            },
            {
                name: "query_temporal_state",
                description:
                    "Query the factual state of entities at a specific point in time (snapshot/time-travel query).",
                parameters: {
                    type: "object",
                    properties: {
                        subject: {
                            type: "string",
                            description: "Subject entity.",
                        },
                        predicate: {
                            type: "string",
                            description: "Relationship/Attribute.",
                        },
                        object: {
                            type: "string",
                            description: "Value/Target entity.",
                        },
                        at: {
                            type: "string",
                            description:
                                "ISO date string or timestamp representing the point in time.",
                        },
                        userId: { type: "string" },
                    },
                    required: userIdRequired ? ["userId"] : [],
                },
            },
            {
                name: "store_temporal_fact",
                description:
                    "Store a structured, time-aware fact into the knowledge graph (e.g., 'User lives in Paris' valid from '2020-01-01').",
                parameters: {
                    type: "object",
                    required: baseRequired(["subject", "predicate", "object"]),
                    properties: {
                        subject: { type: "string" },
                        predicate: { type: "string" },
                        object: { type: "string" },
                        confidence: { type: "number", default: 1.0 },
                        validFrom: {
                            type: "string",
                            description: "ISO date string or timestamp.",
                        },
                        metadata: {
                            type: "object",
                            description: "Optional structured metadata.",
                        },
                        userId: { type: "string" },
                    },
                },
            },
            {
                name: "update_temporal_fact",
                description: "Update the confidence or metadata of an existing temporal fact.",
                parameters: {
                    type: "object",
                    properties: {
                        factId: { type: "string" },
                        confidence: { type: "number", description: "New confidence (0-1)" },
                        metadata: { type: "object", description: "Metadata to merge" },
                        userId: { type: "string" },
                    },
                    required: baseRequired(["factId"]),
                },
            },
            {
                name: "invalidate_temporal_fact",
                description:
                    "End the validity of a specific fact (e.g., when a status changes).",
                parameters: {
                    type: "object",
                    properties: {
                        factId: {
                            type: "string",
                            description: "UUID of the fact to invalidate.",
                        },
                        validTo: {
                            type: "string",
                            description:
                                "ISO date string or timestamp marking the end of validity.",
                        },
                        userId: { type: "string" },
                    },
                    required: baseRequired(["factId"]),
                },
            },
            {
                name: "store_relation_edge",
                description:
                    "Store a non-temporal semantic relation between entities in the graph.",
                parameters: {
                    type: "object",
                    properties: {
                        source: {
                            type: "string",
                            description: "Source entity ID.",
                        },
                        target: {
                            type: "string",
                            description: "Target entity ID.",
                        },
                        relationType: {
                            type: "string",
                            description: "Type of relation.",
                        },
                        weight: { type: "number", default: 1.0 },
                        metadata: {
                            type: "object", // Added to support metadata
                            description: "Optional edge metadata."
                        },
                        userId: { type: "string" },
                    },
                    required: baseRequired(["source", "target", "relationType"]),
                },
            },
            {
                name: "update_temporal_edge",
                description: "Update the weight or metadata of an existing relationship edge.",
                parameters: {
                    type: "object",
                    properties: {
                        edgeId: { type: "string" },
                        weight: { type: "number", description: "New weight (0-1)" },
                        metadata: { type: "object", description: "Metadata to merge" },
                        userId: { type: "string" },
                    },
                    required: baseRequired(["edgeId"]),
                },
            },
            {
                name: "summarize",
                description:
                    "Compress or summarize a large block of text to extract key meaning.",
                parameters: {
                    type: "object",
                    properties: {
                        content: {
                            type: "string",
                            description: "Text to summarize.",
                        },
                    },
                    required: ["content"],
                },
            },
            {
                name: "store_node_memory",
                description: "Store memory associated with a specific cognitive node/step in a thread (LangGraph style).",
                parameters: {
                    type: "object",
                    properties: {
                        node: { type: "string", description: "Node name (e.g., perceive, plan, act)." },
                        content: { type: "string", description: "Observation or result to store." },
                        namespace: { type: "string", default: "default" },
                        graphId: { type: "string", description: "Optional thread/graph ID." },
                        userId: { type: "string" },
                    },
                    required: baseRequired(["node", "content"]),
                },
            },
            {
                name: "get_graph_context",
                description: "Get a summarized cognitive context for the current execution thread across all nodes.",
                parameters: {
                    type: "object",
                    properties: {
                        namespace: { type: "string", default: "default" },
                        graphId: { type: "string", description: "Optional thread/graph ID." },
                        limit: { type: "integer", default: 20 },
                        userId: { type: "string" },
                    },
                    required: userIdRequired ? ["userId"] : [],
                },
            },
        ];
    }
}
