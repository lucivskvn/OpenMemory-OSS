/**
 * @file mcp_tools_temporal.ts
 * @description Temporal Graph tools registration for the MCP server.
 * @audited 2026-01-19
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Memory } from "../core/memory";
import {
    TemporalFactSchema,
    TemporalQuerySchema,
    TemporalSearchSchema,
    TemporalCompareSchema,
    TemporalDecaySchema,
    TemporalTimelineSchema,
    TemporalFactUpdateSchema,
    TemporalEdgeCreateSchema,
    TemporalEdgeUpdateSchema,
    TemporalEdgeQuerySchema,
    TemporalStatsSchema,
} from "./schemas";
import { verifyContext } from "../core/context";

export const registerTemporalGraphTools = (srv: McpServer, mem: Memory): void => {
    srv.tool(
        "openmemory_temporal_fact_create",
        "Add a fact to the temporal knowledge graph (subject-predicate-object)",
        TemporalFactSchema.shape,
        async (args: z.infer<typeof TemporalFactSchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.add(args.subject, args.predicate, args.object, {
                validFrom: args.validFrom ? new Date(args.validFrom) : undefined,
                confidence: args.confidence,
                metadata: args.metadata,
            });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_fact_update",
        "Update confidence or metadata of a temporal fact",
        TemporalFactUpdateSchema.shape,
        async (args: z.infer<typeof TemporalFactUpdateSchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.updateFact(
                args.factId,
                args.confidence,
                args.metadata,
            );
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_fact_query",
        "Query the current state of facts at a point in time",
        TemporalQuerySchema.shape,
        async (args: z.infer<typeof TemporalQuerySchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.queryFacts(
                args.subject,
                args.predicate,
                args.object,
                args.at ? new Date(args.at) : undefined,
            );
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_fact_search",
        "Keyword search across facts in the temporal graph",
        TemporalSearchSchema.shape,
        async (args: z.infer<typeof TemporalSearchSchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.search(args.query, { limit: args.limit });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_fact_compare",
        "Compare facts for a subject between two points in time",
        TemporalCompareSchema.shape,
        async (args: z.infer<typeof TemporalCompareSchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.compare(
                args.subject,
                args.time1 ? new Date(args.time1) : new Date(0),
                args.time2 ? new Date(args.time2) : new Date(),
            );
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_stats",
        "Get temporal graph stats",
        TemporalStatsSchema.shape,
        async (args: z.infer<typeof TemporalStatsSchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const stats = await scopedMem.temporal.stats();
            return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_decay",
        "Manually trigger confidence decay for temporal facts based on time",
        TemporalDecaySchema.shape,
        async (args: z.infer<typeof TemporalDecaySchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.decay(args.decayRate);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_timeline",
        "Get timeline of facts for a subject",
        TemporalTimelineSchema.shape,
        async (args: z.infer<typeof TemporalTimelineSchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.timeline(args.subject);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_edge_create",
        "Create a relationship edge between two memories",
        TemporalEdgeCreateSchema.shape,
        async (args: z.infer<typeof TemporalEdgeCreateSchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.addEdge(
                args.sourceId,
                args.targetId,
                args.relationType,
                {
                    weight: args.weight,
                    validFrom: args.validFrom ? new Date(args.validFrom) : undefined,
                    metadata: args.metadata,
                },
            );
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_edge_update",
        "Update weight or metadata of an edge",
        TemporalEdgeUpdateSchema.shape,
        async (args: z.infer<typeof TemporalEdgeUpdateSchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.updateEdge(args.edgeId, args.weight, args.metadata);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_temporal_edge_query",
        "Search for relationship edges",
        TemporalEdgeQuerySchema.shape,
        async (args: z.infer<typeof TemporalEdgeQuerySchema>) => {
            const userId = verifyContext(args.userId);
            const scopedMem = new Memory(userId || undefined);
            const res = await scopedMem.temporal.getEdges(
                args.sourceId,
                args.targetId,
                args.relationType,
                args.at ? new Date(args.at) : undefined,
                args.limit,
                args.offset
            );
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );
};
