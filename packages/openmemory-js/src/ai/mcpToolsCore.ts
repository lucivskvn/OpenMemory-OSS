/**
 * @file mcpToolsCore.ts
 * @description Core Memory tools registration for the MCP server.
 * @audited 2026-01-19
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Memory } from "../core/memory";
import {
    SearchSchema,
    StoreSchema,
    ReinforceSchema,
    IngestUrlSchema,
    OpenMemoryListSchema,
    OpenMemoryGetSchema,
    OpenMemoryUpdateSchema,
    OpenMemoryDeleteSchema,
    OpenMemoryIngestContentSchema,
} from "./schemas";
import { verifyContext } from "../core/context";

export const registerCoreMemoryTools = (srv: McpServer, mem: Memory): void => {
    srv.tool(
        "openmemory_query",
        "Semantic search across all memory sectors. Use this for free-form questions like 'What do we know about...'",
        SearchSchema.shape,
        async (args: z.infer<typeof SearchSchema>) => {
            const { query, limit, sectors, minSalience, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const results = await mem.search(query, {
                limit,
                sectors: sectors as string[],
                minSalience,
                userId,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(results, null, 2),
                    },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_store",
        "Store a new piece of information into memory. Automatically classifies into episodic, semantic, etc.",
        StoreSchema.shape,
        async (args: z.infer<typeof StoreSchema>) => {
            const { content, tags, metadata, salience, decayLambda, userId: argUserId } = args;
            const userId = verifyContext(argUserId);
            const result = await mem.add(content, { tags, ...metadata, salience, decayLambda, userId });
            return {
                content: [{ type: "text", text: `Memory stored with ID: ${result.id}` }],
            };
        },
    );

    srv.tool(
        "openmemory_reinforce",
        "Reinforce a memory (thumbs up) to increase its salience and prevent it from being forgotten.",
        ReinforceSchema.shape,
        async (args: z.infer<typeof ReinforceSchema>) => {
            const userId = verifyContext(args.userId);
            await mem.reinforce(args.id, args.boost, userId);
            return { content: [{ type: "text", text: `Reinforced memory ${args.id}` }] };
        },
    );

    srv.tool(
        "openmemory_list",
        "List recent memories with pagination",
        OpenMemoryListSchema.shape,
        async (args: z.infer<typeof OpenMemoryListSchema>) => {
            const userId = verifyContext(args.userId);
            const res = await mem.hostList(args.limit, 0, args.sector, userId);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_get",
        "Retrieve a specific memory by ID",
        OpenMemoryGetSchema.shape,
        async (args: z.infer<typeof OpenMemoryGetSchema>) => {
            const userId = verifyContext(args.userId);
            const res = await mem.get(args.id, userId);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_update",
        "Update content, tags, or metadata of an existing memory",
        OpenMemoryUpdateSchema.shape,
        async (args: z.infer<typeof OpenMemoryUpdateSchema>) => {
            const userId = verifyContext(args.userId);
            const res = await mem.update(
                args.id,
                args.content,
                args.tags,
                args.metadata,
                userId,
            );
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_delete",
        "Permanently delete a memory record",
        OpenMemoryDeleteSchema.shape,
        async (args: z.infer<typeof OpenMemoryDeleteSchema>) => {
            const userId = verifyContext(args.userId);
            await mem.delete(args.id, userId);
            return { content: [{ type: "text", text: `Deleted memory ${args.id}` }] };
        },
    );
};

export const registerIngestTools = (srv: McpServer, mem: Memory): void => {
    srv.tool(
        "openmemory_ingest_url",
        "Ingest content from a URL (e.g., documentation, blog post) into memory.",
        IngestUrlSchema.shape,
        async (args: z.infer<typeof IngestUrlSchema>) => {
            const userId = verifyContext(args.userId);
            try {
                const res = await mem.ingestUrl(args.url, {
                    tags: args.tags,
                    metadata: args.metadata,
                    config: args.config,
                    userId,
                });
                return {
                    content: [{ type: "text", text: `Ingestion complete. Root ID: ${res.rootMemoryId}` }],
                };
            } catch (error) {
                return {
                    content: [{ type: "text", text: `Ingestion failed: ${error instanceof Error ? error.message : String(error)}` }],
                    isError: true,
                };
            }
        },
    );

    srv.tool(
        "openmemory_ingest_content",
        "Ingest raw text content as a document (supports chunking and tagging)",
        OpenMemoryIngestContentSchema.shape,
        async (args: z.infer<typeof OpenMemoryIngestContentSchema>) => {
            const userId = verifyContext(args.userId);
            try {
                const res = await mem.ingestDocument(args.contentType, args.content, {
                    tags: args.tags || [],
                    metadata: args.metadata,
                    config: args.config,
                    userId,
                });
                return {
                    content: [{ type: "text", text: `Ingestion complete. Root ID: ${res.rootMemoryId}` }],
                };
            } catch (error) {
                return {
                    content: [{ type: "text", text: `Ingestion failed: ${error instanceof Error ? error.message : String(error)}` }],
                    isError: true,
                };
            }
        },
    );
};
