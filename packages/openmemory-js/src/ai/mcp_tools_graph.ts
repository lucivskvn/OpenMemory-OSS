/**
 * @file mcp_tools_graph.ts
 * @description Graph and IDE tools registration for the MCP server.
 * @audited 2026-01-19
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Memory } from "../core/memory";
import {
    StoreNodeSchema,
    RetrieveNodeMemsSchema,
    GetGraphContextSchema,
    IdeContextSchema,
    IdePatternsSchema,
} from "./schemas";
import { z } from "zod";
import { verifyContext } from "../core/context";
import { storeNodeMem, retrieveNodeMems, getGraphCtx } from "./graph";
import { getIdeContext, getIdePatterns } from "./ide";

export const registerLangGraphTools = (srv: McpServer, mem: Memory): void => {
    srv.tool(
        "openmemory_store_node_mem",
        "Store memory from a specific agent work node (e.g., plan, observe, reflect)",
        StoreNodeSchema.shape,
        async (args: z.infer<typeof StoreNodeSchema>) => {
            const userId = verifyContext(args.userId);
            const res = await storeNodeMem({ ...args, userId });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_retrieve_node_mems",
        "Retrieve memories for a specific node/namespace in the graph",
        RetrieveNodeMemsSchema.shape,
        async (args: z.infer<typeof RetrieveNodeMemsSchema>) => {
            const userId = verifyContext(args.userId);
            const res = await retrieveNodeMems({
                node: args.node,
                namespace: args.namespace,
                query: args.query,
                limit: args.limit,
                userId,
            });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_get_graph_context",
        "Get aggregated context from across all graph nodes for the current thread",
        GetGraphContextSchema.shape,
        async (args: z.infer<typeof GetGraphContextSchema>) => {
            const userId = verifyContext(args.userId);
            const res = await getGraphCtx({
                namespace: args.namespace || "default",
                graphId: args.graphId,
                limit: args.limit,
                userId,
            });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );
};

export const registerIdeTools = (srv: McpServer, mem: Memory): void => {
    srv.tool(
        "openmemory_get_ide_context",
        "Retrieve coding context (snippets, files) related to a query",
        IdeContextSchema.shape,
        async (args: z.infer<typeof IdeContextSchema>) => {
            const userId = verifyContext(args.userId);
            const res = await getIdeContext({ ...args, userId });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_get_ide_patterns",
        "Retrieve recurring coding patterns or project conventions",
        IdePatternsSchema.shape,
        async (args: z.infer<typeof IdePatternsSchema>) => {
            const userId = verifyContext(args.userId);
            const res = await getIdePatterns({ ...args, userId });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );
};
