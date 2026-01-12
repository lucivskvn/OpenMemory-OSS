import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";

import { env } from "../core/cfg";
import { runInContext, SecurityContext, verifyContext } from "../core/context";
import { vectorStore } from "../core/db";
import { sectorConfigs } from "../core/hsg_config";
import { Memory } from "../core/memory";
import {
    type HsgQueryResult,
    type RpcErrorCode,
    type SectorType,
} from "../core/types";
import { getEmbeddingInfo } from "../memory/embed";
import { AppError } from "../server/errors";
import type { AdvancedRequest, ServerApp } from "../server/server";
import { queryFactsAtTime } from "../temporal_graph/query";
import { logger } from "../utils/logger";
import { storeNodeMem } from "./graph";
import { getIdeContext, getIdePatterns } from "./ide";
import {
    SearchSchema,
    sectorEnum,
    StoreSchema,
    TemporalCompareSchema,
    TemporalDecaySchema,
    TemporalFactSchema,
    TemporalQuerySchema,
    TemporalSearchSchema,
} from "./schemas";

/**
 * MCP Server version - synchronized with package.json version.
 * Update this when releasing new versions.
 */
const MCP_VERSION = "2.3.0";

/**
 * MCP Protocol date - indicates the protocol specification version.
 * @see https://modelcontextprotocol.io/specification/versioning
 */
const MCP_PROTOCOL_DATE = "2025-11-25";

/* sectorEnum exported from schemas.ts */

const truncate = (val: string, max = 200) =>
    val.length <= max ? val : `${val.slice(0, max).trimEnd()}...`;

/**
 * Format query results into a human-readable list for LLM consumption.
 * @param matches Array of HSG query results.
 */
const formatMatches = (matches: HsgQueryResult[]): string =>
    matches
        .map((m, idx) => {
            const preview = truncate(
                m.content.replace(/\s+/g, " ").trim(),
                200,
            );
            return `${idx + 1}. [${m.primarySector}] score=${(m.score || 0).toFixed(3)} salience=${(m.salience || 0).toFixed(3)} id=${m.id}\n${preview}`;
        })
        .join("\n\n");

const setHeaders = (res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Mcp-Session-Id",
    );
};

const sendMcpError = (
    res: ServerResponse,
    code: RpcErrorCode,
    msg: string,
    id: number | string | null = null,
    status = 400,
) => {
    if (!res.headersSent) {
        res.statusCode = status;
        setHeaders(res);
        res.end(
            JSON.stringify({
                jsonrpc: "2.0",
                error: { code, message: msg },
                id,
            }),
        );
    }
};

const handleToolError = (
    res: ServerResponse,
    error: unknown,
    id: number | string | null = null,
) => {
    logger.error(`[MCP] Tool Execution Error:`, { error });
    if (error instanceof AppError) {
        sendMcpError(res, -32603, error.message, id, error.statusCode);
    } else if (error instanceof z.ZodError) {
        sendMcpError(
            res,
            -32602,
            `Validation error: ${error.issues.map((e: z.ZodIssue) => e.message).join(", ")}`,
            id,
            400,
        );
    } else {
        const msg = error instanceof Error ? error.message : String(error);
        sendMcpError(res, -32603, `Internal Error: ${msg}`, id, 500);
    }
};

/**
 * Creates and configures a Model Context Protocol (MCP) server instance.
 * Exposes tools for memory querying, storage, reinforcement, and temporal graph operations.
 */
export const createMcpServer = () => {
    const mem = new Memory();
    const srv = new McpServer(
        {
            name: "openmemory-mcp",
            version: MCP_VERSION,
        },
        {
            capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: false, listChanged: true },
                logging: {},
            },
        },
    );



    // Helper to wrap tool implementation with error handling
    const wrapTool = <T extends Record<string, any>, R extends { content: { type: "text"; text: string }[] }>(
        impl: (args: T) => Promise<R>
    ) => async (args: T) => {
        try {
            return await impl(args);
        } catch (error) {
            logger.error(`[MCP] Tool Execution Error`, { error });
            const msg = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{ type: "text" as const, text: `Error: ${msg}` }]
            };
        }
    };

    /**
     * Tool: openmemory_query
     * Semantic search over the memory store using hybrid retrieval (Vector + BM25).
     */
    srv.tool(
        "openmemory_query",
        "Semantic search over the memory store",
        {
            query: SearchSchema.shape.query,
            limit: SearchSchema.shape.limit
                .optional()
                .describe("Maximum number of results to return"),
            k: SearchSchema.shape.limit
                .optional()
                .describe("Legacy alias for limit"),
            sector: sectorEnum
                .optional()
                .describe("Restrict search to a specific cognitive sector"),
            minSalience: SearchSchema.shape.minSalience,
            userId: SearchSchema.shape.userId,
        },
        wrapTool(async (args: {
            query: string;
            k?: number;
            limit?: number;
            sector?: SectorType;
            minSalience?: number;
            userId?: string;
        }) => {
            const {
                query,
                k,
                limit,
                sector,
                minSalience,
                userId: argUserId,
            } = args;
            const finalLimit = limit || k || 5;

            const userId = verifyContext(argUserId);

            const matches = await mem.search(query, {
                userId,
                limit: finalLimit,
                sectors: sector ? [sector] : undefined,
                minSalience, // Pass directly to hsgQuery via Memory.search
            });

            const summaryText = matches.length
                ? formatMatches(matches)
                : "No memories matched the supplied query.";

            const payload = matches.map((m: HsgQueryResult) => ({
                id: m.id,
                score: Number((m.score || 0).toFixed(4)),
                primarySector: m.primarySector,
                salience: Number((m.salience || 0).toFixed(4)),
                content: truncate(m.content, 300), // TRUNCATE for MCP to save context window
            }));
            return {
                content: [
                    { type: "text" as const, text: summaryText },
                    {
                        type: "text" as const,
                        text: JSON.stringify(
                            { query, count: matches.length, matches: payload },
                            null,
                            2,
                        ),
                    },
                ],
            };
        }),
    );

    /**
     * Tool: openmemory_store
     * Store a new memory fragment into the system.
     * Automatically handles embedding generation and vector storage.
     */
    srv.tool(
        "openmemory_store",
        "Store a new memory fragment",
        {
            content: StoreSchema.shape.content,
            tags: StoreSchema.shape.tags,
            metadata: StoreSchema.shape.metadata,
            userId: StoreSchema.shape.userId,
        },
        wrapTool(async (args: {
            content: string;
            tags?: string[];
            metadata?: Record<string, unknown>;
            userId?: string;
        }) => {
            const { content, tags, metadata, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const res = await mem.add(content, { userId, tags, ...metadata });

            const statusText = `Stored memory ${res.id} (primary=${res.primarySector})${userId ? ` [user=${userId}]` : ""}`;
            const payload = {
                id: res.id,
                primarySector: res.primarySector,
                userId: userId ?? null,
            };
            return {
                content: [
                    { type: "text" as const, text: statusText },
                    {
                        type: "text" as const,
                        text: JSON.stringify(payload, null, 2),
                    },
                ],
            };
        }),
    );

    /**
     * Tool: openmemory_ingest_url
     * Ingest content from a given URL (webpage, PDF, etc.).
     */
    srv.tool(
        "openmemory_ingest_url",
        "Ingest content from a URL",
        {
            url: z.string().url().refine(u => u.startsWith("http://") || u.startsWith("https://"), { message: "Only HTTP/HTTPS URLs are allowed" }).describe("URL to ingest content from (HTTP/HTTPS only)"),
            tags: z
                .array(z.string())
                .optional()
                .describe("Tags to apply to ingested memory"),
            userId: z.string().optional().describe("User context"),
        },
        wrapTool(async (args: { url: string; tags?: string[]; userId?: string }) => {
            const { url, tags, userId: argUserId } = args;
            const userId = verifyContext(argUserId);

            // Lazy import to handle potential circular deps or load time
            const { ingestUrl } = await import("../ops/ingest");

            const result = await ingestUrl(
                url,
                { source: "mcp_url", tags },
                {},
                userId ?? undefined,
            );

            return {
                content: [
                    { type: "text" as const, text: `Ingested URL: ${url}` },
                    {
                        type: "text" as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }),
    );

    /**
     * Tool: openmemory_reinforce
     * Increase the salience (importance) of a specific memory.
     */
    srv.tool(
        "openmemory_reinforce",
        "Reinforce a memory's salience",
        {
            id: z.string().min(1).describe("Memory identifier to reinforce"),
            boost: z
                .number()
                .min(0.01)
                .max(1)
                .default(0.1)
                .describe("Salience boost amount (default 0.1)"),
            userId: z
                .string()
                .optional()
                .describe("Optional user context for authorization"),
        },
        wrapTool(async (args: { id: string; boost: number; userId?: string }) => {
            const { id, boost, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;
            await m.reinforce(id, boost);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Reinforced memory ${id} by ${boost}`,
                    },
                ],
            };
        }),
    );

    /**
     * Tool: openmemory_ingest_content
     * Ingest raw text content directly with optional metadata and config.
     */
    srv.tool(
        "openmemory_ingest_content",
        "Ingest raw content with processing",
        {
            content: z.string().min(1).describe("Text content to ingest"),
            contentType: z.string().min(1).default("text/plain").describe("MIME type"),
            tags: z.array(z.string()).optional(),
            metadata: z.record(z.string(), z.any()).optional(),
            config: z.record(z.string(), z.any()).optional(),
            userId: z.string().optional(),
        },
        wrapTool(async (args: {
            content: string;
            contentType: string;
            tags?: string[];
            metadata?: Record<string, unknown>;
            config?: Record<string, unknown>;
            userId?: string;
        }) => {
            const { content, contentType, tags, metadata, config, userId: argUserId } = args;
            const userId = verifyContext(argUserId);

            // Lazy import
            const { ingestDocument } = await import("../ops/ingest");

            const result = await ingestDocument(
                contentType,
                content,
                { ...metadata, tags }, // Tags are merged into metadata in ingest pipeline
                config,
                userId ?? undefined
            );

            return {
                content: [
                    { type: "text" as const, text: `Ingested content (${result.totalTokens} tokens)` },
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            rootId: result.rootMemoryId,
                            childCount: result.childCount,
                            strategy: result.strategy
                        }, null, 2),
                    },
                ],
            };
        })
    );

    /**
     * Tool: openmemory_list
     * List recent memories with optional sector or user filtering.
     */
    srv.tool(
        "openmemory_list",
        "List recent memories",
        {
            limit: z
                .number()
                .int()
                .min(1)
                .max(50)
                .default(10)
                .describe("Number of memories to return"),
            sector: sectorEnum
                .optional()
                .describe("Optionally limit to a sector"),
            userId: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Restrict results to a specific user identifier"),
        },
        wrapTool(async (args: {
            limit: number;
            sector?: SectorType;
            userId?: string;
        }) => {
            const { limit, sector, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;

            // Use hostList which supports sector filtering at the database level
            const items = await m.hostList(limit, 0, sector, userId);

            const lines = items.map(
                (item, idx) =>
                    `${idx + 1}. [${item.primarySector}] salience=${(item.salience || 0).toFixed(3)} id=${item.id}${item.tags.length ? ` tags=${item.tags.join(", ")}` : ""}${item.userId ? ` user=${item.userId}` : ""}\n${truncate(item.content, 200)}`,
            );
            return {
                content: [
                    {
                        type: "text" as const,
                        text: lines.join("\n\n") || "No memories stored yet.",
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify({ items }, null, 2),
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_get",
        "Retrieve a specific memory by ID",
        {
            id: z.string().min(1).describe("Memory identifier to load"),
            includeVectors: z
                .boolean()
                .default(false)
                .describe("Include sector vector metadata"),
            userId: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                    "Validate ownership against a specific user identifier",
                ),
        },
        wrapTool(async (args: {
            id: string;
            includeVectors: boolean;
            userId?: string;
        }) => {
            const { id, includeVectors, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;
            const item = await m.get(id);
            if (!item)
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Memory ${id} not found.`,
                        },
                    ],
                };

            const result: Record<string, unknown> = { ...item };

            // Fetch vectors if requested
            if (includeVectors) {
                const vectors = await vectorStore.getVectorsByIds([id], userId);
                result.vectors = vectors.map((v) => ({
                    sector: v.sector,
                    dim: v.dim,
                    // Include first 8 elements as preview to avoid large payloads
                    vectorPreview: v.vector.slice(0, 8),
                    vectorLength: v.vector.length,
                }));
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_update",
        "Update an existing memory",
        {
            id: z.string().min(1).describe("Memory identifier to update"),
            content: z.string().optional().describe("New content text"),
            tags: z.array(z.string()).optional().describe("New tags"),
            metadata: z.record(z.string(), z.any()).optional().describe("Metadata updates"),
            userId: z.string().optional().describe("User context for ownership validation"),
        },
        wrapTool(async (args: {
            id: string;
            content?: string;
            tags?: string[];
            metadata?: Record<string, unknown>;
            userId?: string;
        }) => {
            const { id, content, tags, metadata, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;

            const updated = await m.update(id, content, tags, metadata);
            if (!updated) {
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `Failed to update memory ${id}. It may not exist or belongs to another user.` }],
                };
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Updated memory ${id} successfully.`,
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(updated, null, 2),
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_delete",
        "Delete a memory",
        {
            id: z.string().min(1).describe("Memory identifier to delete"),
            userId: z.string().optional().describe("User context for ownership validation"),
        },
        wrapTool(async (args: { id: string; userId?: string }) => {
            const { id, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;

            await m.delete(id);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Deleted memory ${id}`,
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_temporal_fact_create",
        "Create a temporal fact (triplet). High-level knowledge storage.",
        {
            subject: TemporalFactSchema.shape.subject,
            predicate: TemporalFactSchema.shape.predicate,
            object: TemporalFactSchema.shape.object,
            validFrom: TemporalFactSchema.shape.validFrom,
            confidence: TemporalFactSchema.shape.confidence,
            userId: TemporalFactSchema.shape.userId,
            metadata: TemporalFactSchema.shape.metadata,
        },
        wrapTool(async (args: {
            subject: string;
            predicate: string;
            object: string;
            validFrom?: string;
            confidence: number;
            userId?: string;
            metadata?: Record<string, unknown>;
        }) => {
            const {
                subject,
                predicate,
                object,
                validFrom,
                confidence,
                userId: argUserId,
                metadata,
            } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;
            let from: Date | undefined;
            if (validFrom) {
                const parsed = new Date(validFrom);
                if (!isNaN(parsed.getTime())) from = parsed;
            }
            const id = await m.temporal.add(subject, predicate, object, {
                validFrom: from,
                confidence,
                metadata,
            });
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Created temporal fact ${id}: ${subject} ${predicate} ${object} (confidence: ${confidence})`,
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_temporal_fact_query",
        "Query temporal facts at a specific point in time (Time Travel).",
        {
            subject: TemporalQuerySchema.shape.subject,
            predicate: TemporalQuerySchema.shape.predicate,
            object: TemporalQuerySchema.shape.object,
            at: TemporalQuerySchema.shape.at,
            userId: TemporalQuerySchema.shape.userId,
        },
        wrapTool(async (args: {
            subject?: string;
            predicate?: string;
            object?: string;
            at?: string;
            userId?: string;
        }) => {
            const { subject, predicate, object, at, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const atDate = at ? new Date(at) : new Date();

            // Use queryFactsAtTime for precise filtering by subject/predicate/object
            const facts = await queryFactsAtTime(
                subject || undefined,
                predicate || undefined,
                object || undefined,
                atDate,
                0.0, // minConfidence
                userId,
            );

            return {
                content: [
                    {
                        type: "text" as const,
                        text: facts.length
                            ? `Found ${facts.length} facts:`
                            : "No facts found matching criteria.",
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(facts, null, 2),
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_temporal_fact_update",
        "Update an existing temporal fact",
        {
            factId: z.string().min(1).describe("Fact ID to update"),
            confidence: z.number().optional().describe("New confidence score (0-1)"),
            metadata: z.record(z.string(), z.any()).optional().describe("Metadata updates"),
            userId: z.string().optional(),
        },
        wrapTool(async (args: {
            factId: string;
            confidence?: number;
            metadata?: Record<string, unknown>;
            userId?: string;
        }) => {
            const { factId, confidence, metadata, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;

            await m.temporal.updateFact(factId, confidence, metadata);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Updated fact ${factId}`,
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_temporal_timeline",
        "Get timeline for a subject",
        {
            subject: z.string().min(1).describe("Subject to get timeline for"),
            userId: z.string().optional(),
        },
        wrapTool(async (args: { subject: string; userId?: string }) => {
            const { subject, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;
            const timeline = await m.temporal.history(subject);
            return {
                content: [
                    { type: "text" as const, text: `Timeline for ${subject}:` },
                    {
                        type: "text" as const,
                        text: JSON.stringify(timeline, null, 2),
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_temporal_edge_create",
        "Create a relationship edge",
        {
            sourceId: z.string().describe("ID of the source temporal fact"),
            targetId: z.string().describe("ID of the target temporal fact"),
            relationType: z
                .string()
                .describe(
                    "Type of relation (e.g., 'causal', 'temporal_before)",
                ),
            weight: z.number().min(0).max(1).default(1.0),
            userId: z.string().optional(),
        },
        wrapTool(async (args: {
            sourceId: string;
            targetId: string;
            relationType: string;
            weight: number;
            userId?: string;
        }) => {
            const {
                sourceId,
                targetId,
                relationType,
                weight,
                userId: argUserId,
            } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;
            const id = await m.temporal.addEdge(
                sourceId,
                targetId,
                relationType,
                { weight },
            );
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Created temporal edge ${id}: ${sourceId} --[${relationType}]--> ${targetId} (weight: ${weight})`,
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_temporal_edge_query",
        "Query relationship edges",
        {
            sourceId: z.string().optional(),
            targetId: z.string().optional(),
            relationType: z.string().optional(),
            userId: z.string().optional(),
        },
        wrapTool(async (args: {
            sourceId?: string;
            targetId?: string;
            relationType?: string;
            userId?: string;
        }) => {
            const {
                sourceId,
                targetId,
                relationType,
                userId: argUserId,
            } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;
            const edges = await m.temporal.getEdges(
                sourceId,
                targetId,
                relationType,
            );
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Found ${edges.length} edges:`,
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(edges, null, 2),
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_temporal_edge_update",
        "Update an existing temporal edge",
        {
            edgeId: z.string().min(1).describe("Edge ID to update"),
            weight: z.number().optional().describe("New weight"),
            metadata: z.record(z.string(), z.any()).optional().describe("Metadata updates"),
            userId: z.string().optional(),
        },
        wrapTool(async (args: {
            edgeId: string;
            weight?: number;
            metadata?: Record<string, unknown>;
            userId?: string;
        }) => {
            const { edgeId, weight, metadata, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;

            await m.temporal.updateEdge(edgeId, weight, metadata);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Updated edge ${edgeId}`,
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_temporal_fact_compare",
        "Compare factual state of a subject between two points in time",
        {
            subject: TemporalCompareSchema.shape.subject,
            time1: TemporalCompareSchema.shape.time1,
            time2: TemporalCompareSchema.shape.time2,
            userId: TemporalCompareSchema.shape.userId,
        },
        wrapTool(async (args: {
            subject: string;
            time1?: string;
            time2?: string;
            userId?: string;
        }) => {
            const { subject, time1, time2, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;

            const t2 = time2 ? new Date(time2) : new Date();
            const t1 = time1 ? new Date(time1) : new Date(Date.now() - 86400000);

            const comparison = await m.temporal.compare(subject, t1, t2);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Comparison for ${subject} between ${t1.toISOString()} and ${t2.toISOString()}:`,
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(comparison, null, 2),
                    },
                ],
            };
        })
    );

    srv.tool(
        "openmemory_temporal_stats",
        "Get global statistics for temporal facts and edges",
        {
            userId: z.string().optional().describe("User context"),
        },
        wrapTool(async (args: { userId?: string }) => {
            const userId = verifyContext(args.userId);
            const m = userId ? new Memory(userId) : mem;
            const stats = await m.temporal.stats();

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(stats, null, 2),
                    },
                ],
            };
        })
    );

    srv.tool(
        "openmemory_temporal_decay",
        "Apply confidence decay to active facts",
        {
            decayRate: TemporalDecaySchema.shape.decayRate,
            userId: TemporalDecaySchema.shape.userId,
        },
        wrapTool(async (args: { decayRate?: number; userId?: string }) => {
            const userId = verifyContext(args.userId);
            const m = userId ? new Memory(userId) : mem;
            const changes = await m.temporal.decay(args.decayRate);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Confidence decay applied. ${changes} facts affected.`,
                    },
                ],
            };
        })
    );

    srv.tool(
        "openmemory_get_graph_context",
        "Retrieve related facts and entities for a specific fact (subgraph traversal)",
        {
            factId: z.string().min(1).describe("Centric fact ID"),
            relation: z.string().optional().describe("Filter by relation type"),
            at: z.string().optional().describe("Point in time (ISO)"),
            userId: z.string().optional(),
        },
        wrapTool(async (args: { factId: string; relation?: string; at?: string; userId?: string }) => {
            const userId = verifyContext(args.userId);
            const m = userId ? new Memory(userId) : mem;
            const atDate = args.at ? new Date(args.at) : new Date();

            const context = await m.temporal.getGraphContext(args.factId, {
                relationType: args.relation,
                at: atDate,
            });

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Retrieved graph context for fact ${args.factId}:`,
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(context, null, 2),
                    },
                ],
            };
        })
    );

    srv.tool(
        "openmemory_get_volatile_facts",
        "Retrieve facts that change frequently or have low stability (volatility analysis)",
        {
            subject: z.string().optional().describe("Filter by subject entity"),
            limit: z.number().int().min(1).max(100).default(10),
            userId: z.string().optional(),
        },
        wrapTool(async (args: { subject?: string; limit: number; userId?: string }) => {
            const userId = verifyContext(args.userId);
            const m = userId ? new Memory(userId) : mem;

            const volatile = await m.temporal.volatile(args.subject, args.limit);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: args.subject
                            ? `Most volatile facts for subject "${args.subject}":`
                            : "Most volatile facts in the system:",
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(volatile, null, 2),
                    },
                ],
            };
        })
    );

    srv.tool(
        "openmemory_temporal_fact_search",
        "Search temporal facts using keyword matching across S, P, O components.",
        {
            query: TemporalSearchSchema.shape.query,
            limit: TemporalSearchSchema.shape.limit,
            userId: TemporalSearchSchema.shape.userId,
        },
        wrapTool(async (args: { query: string; limit: number; userId?: string }) => {
            const { query, limit, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const m = userId ? new Memory(userId) : mem;
            const facts = await m.temporal.search(query, { limit });
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Found ${facts.length} facts matching "${query}":`,
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(facts, null, 2),
                    },
                ],
            };
        }),
    );

    srv.tool(
        "openmemory_store_node_mem",
        "Store memory for a specific LangGraph node",
        {
            node: z.string().min(1).describe("The LangGraph node name"),
            memoryId: z.string().optional().describe("ID of an existing memory to link"),
            content: z.string().optional().describe("New content to store"),
            userId: z.string().optional(),
        },
        wrapTool(async (args: {
            node: string;
            memoryId?: string;
            content?: string;
            userId?: string;
        }) => {
            const { node, memoryId, content, userId: argUserId } = args;
            const userId = verifyContext(argUserId);

            // If new content is provided and we have an ID, update the memory first
            // (Note: storeNodeMem now handles memoryId directly too, but we keep this for legacy update logic if needed,
            // or we could let storeNodeMem handle it all).
            // Let's let storeNodeMem handle it for cleaner code.

            const res = await storeNodeMem({
                memoryId,
                content,
                node,
                userId: userId ?? undefined,
            });
            return {
                content: [
                    {
                        type: "text" as const,
                        text: memoryId
                            ? `Stored memory ${memoryId} for node '${node}'`
                            : `Stored new memory for node '${node}'`,
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(res, null, 2),
                    },
                ],
            };
        }),
    );

    /**
     * Tool: openmemory_retrieve_node_mems
     * Retrieve memories associated with a specific LangGraph node.
     */
    srv.tool(
        "openmemory_retrieve_node_mems",
        "Retrieve memories for a LangGraph node",
        {
            node: z.string().min(1).describe("Node identifier"),
            limit: z.number().optional().default(10),
            userId: z.string().optional(),
        },
        wrapTool(async (args: { node: string; limit: number; userId?: string }) => {
            // Lazy import to avoid circular dependency
            const { retrieveNodeMems } = await import("./graph");
            const { node, limit, userId: argUserId } = args;
            const userId = verifyContext(argUserId);

            const memories = await retrieveNodeMems({
                node,
                limit,
                userId: userId ?? undefined,
            });
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Retrieved ${memories.items.length} memories for node '${node}'`,
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(memories, null, 2),
                    },
                ],
            };
        }),
    );

    /**
     * Tool: openmemory_get_ide_context
     * Retrieve relevant context for IDE suggestions based on file content/cursor.
     */
    srv.tool(
        "openmemory_get_ide_context",
        "Get context for IDE based on current file/cursor",
        {
            fileContent: z.string().describe("Current file content"),
            cursorPosition: z.number().describe("Cursor offset"),
            filePath: z.string().describe("Absolute file path"),
            userId: z.string().optional(),
        },
        wrapTool(async (args: {
            fileContent: string;
            cursorPosition: number;
            filePath: string;
            userId?: string;
        }) => {
            const { fileContent, cursorPosition, filePath, userId: argUserId } =
                args;
            const userId = verifyContext(argUserId);

            const context = await getIdeContext({
                content: fileContent,
                line: cursorPosition, // Using cursorPosition as line for now or we could refine this in ide.ts
                file: filePath,
                userId: userId ?? undefined,
            });
            return {
                content: [
                    {
                        type: "text" as const,
                        text: context.success
                            ? `Found ${context.context.length} relevant context items`
                            : "No context found",
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(context, null, 2),
                    },
                ],
            };
        }),
    );

    /**
     * Tool: openmemory_get_ide_patterns
     * Retrieve coding patterns detected for the current session.
     */
    srv.tool(
        "openmemory_get_ide_patterns",
        "Get active coding patterns for the session",
        {
            sessionId: z.string().describe("IDE Session ID"),
            userId: z.string().optional(),
        },
        wrapTool(async (args: { sessionId: string; userId?: string }) => {
            const { sessionId, userId: argUserId } = args;
            const userId = verifyContext(argUserId);

            const result = await getIdePatterns({ sessionId, userId: userId ?? undefined });
            return {
                content: [
                    {
                        type: "text" as const,
                        text: result.success
                            ? `Found ${result.patternCount} active patterns`
                            : "No active patterns",
                    },
                    {
                        type: "text" as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }),
    );

    srv.resource(
        "openmemory-config",
        "openmemory://config",
        {
            mimeType: "application/json",
            description:
                "Runtime configuration snapshot for the OpenMemory MCP server",
        },
        async () => {
            // Security: specific user stats are not available in this static resource context
            // and global aggregation would violate tenant isolation.
            const stats: unknown[] = [];
            const snapshot = {
                mode: env.mode,
                sectors: sectorConfigs,
                stats,
                embeddings: getEmbeddingInfo(),
                server: { version: MCP_VERSION, protocol: MCP_PROTOCOL_DATE },
                server_time: new Date().toISOString(),
                available_tools: [
                    "openmemory_query",
                    "openmemory_store",
                    "openmemory_reinforce",
                    "openmemory_list",
                    "openmemory_get",
                    "openmemory_update",
                    "openmemory_delete",
                    "openmemory_ingest_url",
                    "openmemory_temporal_fact_create",
                    "openmemory_temporal_fact_update",
                    "openmemory_temporal_fact_query",
                    "openmemory_temporal_fact_search",
                    "openmemory_temporal_fact_compare",
                    "openmemory_temporal_stats",
                    "openmemory_temporal_decay",
                    "openmemory_temporal_timeline",
                    "openmemory_temporal_edge_create",
                    "openmemory_temporal_edge_update",
                    "openmemory_temporal_edge_query",
                    "openmemory_store_node_mem",
                    "openmemory_retrieve_node_mems",
                    "openmemory_get_graph_context",
                    "openmemory_get_ide_context",
                    "openmemory_get_ide_patterns",
                ],
            };

            // Inspect active generator for IDE display
            try {
                // Determine what model is currently active (system default)
                // We import dynamically to avoid circular issues if any, though mcp -> adapters is safe
                const { get_generator } = await import("./adapters");
                const gen = await get_generator();
                if (gen) {
                    (snapshot as Record<string, unknown>).active_model = {
                        provider: gen.constructor.name.replace("Generator", ""),
                        model: gen.model,
                    };
                }
            } catch {
                /* ignore */
            }

            return {
                contents: [
                    {
                        uri: "openmemory://config",
                        text: JSON.stringify(snapshot, null, 2),
                    },
                ],
            };
        },
    );

    srv.server.oninitialized = () => {
        logger.info(
            `[MCP] initialization completed with client: ${JSON.stringify(srv.server.getClientVersion())}`,
        );
    };
    return srv;
};

const MAX_PAYLOAD_SIZE = env.maxPayloadSize; // Use configured limit

const extractPayload = async (
    req: IncomingMessage & { body?: unknown },
): Promise<unknown> => {
    if (req.body !== undefined) {
        if (typeof req.body === "string") {
            if (!req.body.trim()) return undefined;
            if (req.body.length > MAX_PAYLOAD_SIZE)
                throw new Error("Payload too large");
            return JSON.parse(req.body);
        }
        if (typeof req.body === "object" && req.body !== null) return req.body;
        return undefined;
    }
    const raw = await new Promise<string>((resolve, reject) => {
        let buf = "";
        req.on("data", (chunk: Buffer | string) => {
            buf += chunk;
            if (buf.length > MAX_PAYLOAD_SIZE) {
                req.destroy(new Error("Payload too large"));
                reject(new Error("Payload too large"));
            }
        });
        req.on("end", () => resolve(buf));
        req.on("error", reject);
    });
    if (!raw.trim()) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        throw new AppError(400, "BAD_REQUEST", "Invalid JSON payload");
    }
};

/**
 * Configures the MCP server to run as part of an Express/HTTP application.
 */
export const mcp = (app: ServerApp) => {
    const srv = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
    });
    const serverReady = srv
        .connect(transport)
        .then(() => {
            logger.info("[MCP] Server started and transport connected");
        })
        .catch((error) => {
            logger.error("[MCP] Failed to initialize transport:", { error });
            throw error;
        });

    const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
        let payload: unknown = null;
        try {
            await serverReady;

            // Only extract payload for POST/PUT requests
            if (req.method !== "GET" && req.method !== "HEAD") {
                payload = await extractPayload(req);
                if (!payload || typeof payload !== "object") {
                    sendMcpError(
                        res,
                        -32600,
                        "Request body must be a JSON object",
                    );
                    return;
                }
                if (env.verbose)
                    logger.info(
                        `[MCP] Incoming request: ${JSON.stringify(payload)}`,
                    );
            }

            setHeaders(res);

            // Handle request - context already established by authenticateApiRequest middleware
            await transport.handleRequest(
                req,
                res,
                payload as import("@modelcontextprotocol/sdk/types.js").JSONRPCRequest,
            );
        } catch (error) {
            const id = (payload as { id?: number | string })?.id ?? null;
            handleToolError(res, error, id);
        }
    };

    app.post("/mcp", (req: any, res: any) => {
        void handleRequest(req, res);
    });
    app.options("/mcp", (_req: any, res: any) => {
        res.statusCode = 204;
        setHeaders(res);
        res.end();
    });

    const method_not_allowed = (_req: any, res: any) => {
        sendMcpError(
            res,
            -32600,
            "Method not supported. Use POST  /mcp with JSON payload.",
            null,
            405,
        );
    };
    app.get("/mcp", (req: any, res: any) => {
        void handleRequest(req, res);
    });
    app.delete("/mcp", method_not_allowed);
    app.put("/mcp", method_not_allowed);
};

/**
 * Starts the MCP server using standard I/O (stdio) transport.
 */
export const startMcpStdio = async () => {
    const srv = createMcpServer();
    const transport = new StdioServerTransport();
    await srv.connect(transport);
};

if (import.meta.main) {
    void startMcpStdio().catch((error) => {
        logger.error("[MCP] STDIO startup failed:", { error });
        process.exitCode = 1;
    });
}
