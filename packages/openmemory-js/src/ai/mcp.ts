import type { IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { env } from "../core/cfg";
import {
    add_hsg_memory,
    hsg_query,
    reinforce_memory,
    sector_configs,
} from "../memory/hsg";
import { q, all_async, memories_table, vector_store } from "../core/db";
import { type hsg_q_result, type MemoryRow } from "../core/types";
import { getEmbeddingInfo } from "../memory/embed";
import { j, p } from "../utils";
import type { sector_type, rpc_err_code, MemoryItem, mem_row } from "../core/types";
import { parse_mem } from "../core/memory";
import { update_user_summary } from "../memory/user_summary";
import { insert_fact, invalidate_fact, insert_edge } from "../temporal_graph/store";
import { query_facts_at_time, query_edges, search_facts } from "../temporal_graph/query";
import { get_subject_timeline } from "../temporal_graph/timeline";

export const sec_enum = z.enum([
    "episodic",
    "semantic",
    "procedural",
    "emotional",
    "reflective",
] as const);

const trunc = (val: string, max = 200) =>
    val.length <= max ? val : `${val.slice(0, max).trimEnd()}...`;

const build_mem_snap = (row: MemoryItem) => ({
    id: row.id,
    primary_sector: row.primary_sector,
    salience: row.salience ? Number(row.salience.toFixed(3)) : 0,
    last_seen_at: row.last_seen_at || 0,
    user_id: row.user_id,
    content_preview: trunc(row.content, 240),
});

const fmt_matches = (matches: hsg_q_result[]) =>
    matches
        .map((m: hsg_q_result, idx: number) => {
            const prev = trunc(m.content.replace(/\s+/g, " ").trim(), 200);
            return `${idx + 1}. [${m.primary_sector}] score=${m.score.toFixed(3)} salience=${m.salience.toFixed(3)} id=${m.id}\n${prev}`;
        })
        .join("\n\n");

const set_hdrs = (res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Mcp-Session-Id",
    );
};

const send_err = (
    res: ServerResponse,
    code: rpc_err_code,
    msg: string,
    id: number | string | null = null,
    status = 400,
) => {
    if (!res.headersSent) {
        res.statusCode = status;
        set_hdrs(res);
        res.end(
            JSON.stringify({
                jsonrpc: "2.0",
                error: { code, message: msg },
                id,
            }),
        );
    }
};

const uid = (val?: string | null) => (val?.trim() ? val.trim() : undefined);

export const create_mcp_srv = () => {
    const srv = new McpServer(
        {
            name: "openmemory-mcp",
            version: "2.1.0",
        },
        { capabilities: { tools: {}, resources: {}, logging: {} } },
    );

    srv.tool(
        "openmemory_query",
        {
            query: z
                .string()
                .min(1, "query text is required")
                .describe("Free-form search text"),
            k: z
                .number()
                .int()
                .min(1)
                .max(32)
                .default(8)
                .describe("Maximum results to return"),
            sector: sec_enum
                .optional()
                .describe("Restrict search to a specific sector"),
            min_salience: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe("Minimum salience threshold"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Isolate results to a specific user identifier"),
        } as any,
        async (args: any) => {
            const { query, k, sector, min_salience, user_id } = args;
            const u = uid(user_id);
            const flt =
                sector || min_salience !== undefined || u
                    ? {
                        ...(sector
                            ? { sectors: [sector as sector_type] }
                            : {}),
                        ...(min_salience !== undefined
                            ? { minSalience: min_salience }
                            : {}),
                        ...(u ? { user_id: u } : {}),
                    }
                    : undefined;
            const matches = await hsg_query(query, k ?? 8, flt);
            const summ = matches.length
                ? fmt_matches(matches)
                : "No memories matched the supplied query.";
            const pay = matches.map((m: hsg_q_result) => ({
                id: m.id,
                score: Number(m.score.toFixed(4)),
                primary_sector: m.primary_sector,
                sectors: m.sectors,
                salience: Number(m.salience.toFixed(4)),
                last_seen_at: m.last_seen_at,
                path: m.path,
                content: m.content,
            }));
            return {
                content: [
                    { type: "text" as const, text: summ },
                    {
                        type: "text" as const,
                        text: JSON.stringify({ query, matches: pay }, null, 2),
                    },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_store",
        {
            content: z.string().min(1).describe("Raw memory text to store"),
            tags: z.array(z.string()).optional().describe("Optional tag list"),
            metadata: z
                .record(z.string(), z.any())
                .optional()
                .describe("Arbitrary metadata blob"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                    "Associate the memory with a specific user identifier",
                ),
        } as any,
        async (args: any) => {
            const { content, tags, metadata, user_id } = args;
            const u = uid(user_id);
            const res = await add_hsg_memory(
                content,
                j(tags || []),
                metadata,
                u,
            );
            if (u)
                update_user_summary(u).catch((err) =>
                    console.error("[MCP] user summary update failed:", err),
                );
            const txt = `Stored memory ${res.id} (primary=${res.primary_sector}) across sectors: ${res.sectors.join(", ")}${u ? ` [user=${u}]` : ""}`;
            const payload = {
                id: res.id,
                primary_sector: res.primary_sector,
                sectors: res.sectors,
                user_id: u ?? null,
            };
            return {
                content: [
                    { type: "text" as const, text: txt },
                    { type: "text" as const, text: JSON.stringify(payload, null, 2) },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_reinforce",
        {
            id: z.string().min(1).describe("Memory identifier to reinforce"),
            boost: z
                .number()
                .min(0.01)
                .max(1)
                .default(0.1)
                .describe("Salience boost amount (default 0.1)"),
            user_id: z.string().optional().describe("Optional user context for authorization"),
        } as any,
        async (args: any) => {
            const { id, boost, user_id } = args;
            const u = uid(user_id);
            await reinforce_memory(id, boost, u);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Reinforced memory ${id} by ${boost}`,
                    },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_list",
        {
            limit: z
                .number()
                .int()
                .min(1)
                .max(50)
                .default(10)
                .describe("Number of memories to return"),
            sector: sec_enum
                .optional()
                .describe("Optionally limit to a sector"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Restrict results to a specific user identifier"),
        } as any,
        async (args: any) => {
            const { limit, sector, user_id } = args;
            const u = uid(user_id);
            let rows: MemoryRow[];
            if (u) {
                const all = await q.all_mem_by_user.all(u, limit ?? 10, 0);
                rows = sector
                    ? all.filter((row) => row.primary_sector === sector)
                    : all;
            } else {
                rows = sector
                    ? await q.all_mem_by_sector.all(sector, limit ?? 10, 0)
                    : await q.all_mem.all(limit ?? 10, 0);
            }
            const items = await Promise.all(rows.map(r => parse_mem(r as unknown as mem_row)));
            const lns = items.map(
                (item, idx) =>
                    `${idx + 1}. [${item.primary_sector}] salience=${item.salience} id=${item.id}${item.tags.length ? ` tags=${item.tags.join(", ")}` : ""}${item.user_id ? ` user=${item.user_id}` : ""}\n${trunc(item.content, 200)}`,
            );
            return {
                content: [
                    {
                        type: "text" as const,
                        text: lns.join("\n\n") || "No memories stored yet.",
                    },
                    { type: "text" as const, text: JSON.stringify({ items }, null, 2) },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_get",
        {
            id: z.string().min(1).describe("Memory identifier to load"),
            include_vectors: z
                .boolean()
                .default(false)
                .describe("Include sector vector metadata"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                    "Validate ownership against a specific user identifier",
                ),
        } as any,
        async (args: any) => {
            const { id, include_vectors, user_id } = args;
            const u = uid(user_id);
            const mem = await q.get_mem.get(id);
            if (!mem)
                return {
                    content: [
                        { type: "text" as const, text: `Memory ${id} not found.` },
                    ],
                };
            if (u && mem.user_id !== u)
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Memory ${id} not found for user ${u}.`,
                        },
                    ],
                };
            const vecs = include_vectors
                ? await vector_store.getVectorsById(id)
                : [];
            const m_item = await parse_mem(mem as unknown as mem_row);
            const pay: Partial<MemoryItem> & { sectors?: string[] } = {
                ...m_item,
                sectors: include_vectors
                    ? vecs.map((v) => v.sector)
                    : undefined,
            };
            return {
                content: [{ type: "text" as const, text: JSON.stringify(pay, null, 2) }],
            };
        },
    );

    srv.tool(
        "openmemory_temporal_fact_create",
        {
            subject: z.string().describe("The subject of the fact (e.g., 'Company A')"),
            predicate: z.string().describe("The relationship (e.g., 'headquarters_in')"),
            object: z.string().describe("The object of the fact (e.g., 'San Francisco')"),
            valid_from: z.string().optional().describe("ISO date string for when the fact became true"),
            confidence: z.number().min(0).max(1).default(1.0).describe("Confidence score (0.0 to 1.0)"),
            user_id: z.string().optional().describe("Owner of this fact"),
            metadata: z.record(z.string(), z.any()).optional().describe("Additional structured data"),
        } as any,
        async (args: any) => {
            const { subject, predicate, object, valid_from, confidence, user_id, metadata } = args;
            const u = uid(user_id);
            const from = valid_from ? new Date(valid_from) : new Date();
            const id = await insert_fact(subject, predicate, object, from, confidence, metadata, u);
            return {
                content: [{ type: "text" as const, text: `Created temporal fact ${id}: ${subject} ${predicate} ${object} (confidence: ${confidence})` }]
            };
        }
    );

    srv.tool(
        "openmemory_temporal_fact_query",
        {
            subject: z.string().optional(),
            predicate: z.string().optional(),
            object: z.string().optional(),
            at: z.string().optional().describe("Query state at this ISO date-time"),
            user_id: z.string().optional(),
        } as any,
        async (args: any) => {
            const { subject, predicate, object, at, user_id } = args;
            const u = uid(user_id);
            const at_date = at ? new Date(at) : new Date();
            const facts = await query_facts_at_time(subject, predicate, object, at_date, 0.1, u);
            return {
                content: [
                    { type: "text" as const, text: facts.length ? `Found ${facts.length} facts:` : "No facts found matching criteria." },
                    { type: "text" as const, text: JSON.stringify(facts, null, 2) }
                ]
            };
        }
    );

    srv.tool(
        "openmemory_temporal_timeline",
        {
            subject: z.string().min(1).describe("Subject to get timeline for"),
            user_id: z.string().optional(),
        } as any,
        async (args: any) => {
            const { subject, user_id } = args;
            const u = uid(user_id);
            const timeline = await get_subject_timeline(subject, u);
            return {
                content: [
                    { type: "text" as const, text: `Timeline for ${subject}:` },
                    { type: "text" as const, text: JSON.stringify(timeline, null, 2) }
                ]
            };
        }
    );

    srv.tool(
        "openmemory_temporal_edge_create",
        {
            source_id: z.string().describe("ID of the source temporal fact"),
            target_id: z.string().describe("ID of the target temporal fact"),
            relation_type: z.string().describe("Type of relation (e.g., 'causal', 'temporal_before')"),
            weight: z.number().min(0).max(1).default(1.0),
            user_id: z.string().optional(),
        } as any,
        async (args: any) => {
            const { source_id, target_id, relation_type, weight, user_id } = args;
            const u = uid(user_id);
            const id = await insert_edge(source_id, target_id, relation_type, new Date(), weight, undefined, u);
            return {
                content: [{ type: "text" as const, text: `Created temporal edge ${id}: ${source_id} --[${relation_type}]--> ${target_id} (weight: ${weight})` }]
            };
        }
    );

    srv.tool(
        "openmemory_temporal_edge_query",
        {
            source_id: z.string().optional(),
            target_id: z.string().optional(),
            relation_type: z.string().optional(),
            user_id: z.string().optional(),
        } as any,
        async (args: any) => {
            const { source_id, target_id, relation_type, user_id } = args;
            const u = uid(user_id);
            const edges = await query_edges(source_id, target_id, relation_type, new Date(), u);
            return {
                content: [
                    { type: "text" as const, text: `Found ${edges.length} edges:` },
                    { type: "text" as const, text: JSON.stringify(edges, null, 2) }
                ]
            };
        }
    );

    srv.tool(
        "openmemory_temporal_fact_search",
        {
            query: z.string().min(1).describe("Keyword to search for in facts"),
            limit: z.number().int().min(1).default(10),
            user_id: z.string().optional(),
        } as any,
        async (args: any) => {
            const { query, limit, user_id } = args;
            const u = uid(user_id);
            const facts = await search_facts(query, "all", undefined, limit, u);
            return {
                content: [
                    { type: "text" as const, text: `Found ${facts.length} facts matching "${query}":` },
                    { type: "text" as const, text: JSON.stringify(facts, null, 2) }
                ]
            };
        }
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
            const stats = await all_async(
                `select primary_sector as sector, count(*) as count, avg(salience) as avg_salience from ${memories_table} group by primary_sector`,
            );
            const pay = {
                mode: env.mode,
                sectors: sector_configs,
                stats,
                embeddings: getEmbeddingInfo(),
                server: { version: "2.1.0", protocol: "2025-06-18" },
                available_tools: [
                    "openmemory_query",
                    "openmemory_store",
                    "openmemory_reinforce",
                    "openmemory_list",
                    "openmemory_get",
                    "openmemory_temporal_fact_create",
                    "openmemory_temporal_fact_query",
                    "openmemory_temporal_fact_search",
                    "openmemory_temporal_timeline",
                    "openmemory_temporal_edge_create",
                    "openmemory_temporal_edge_query",
                ],
            };
            return {
                contents: [
                    {
                        uri: "openmemory://config",
                        text: JSON.stringify(pay, null, 2),
                    },
                ],
            };
        },
    );

    srv.server.oninitialized = () => {
        // Use stderr for debug output, not stdout
        console.error(
            "[MCP] initialization completed with client:",
            srv.server.getClientVersion(),
        );
    };
    return srv;
};

const extract_pay = async (req: IncomingMessage & { body?: any }) => {
    if (req.body !== undefined) {
        if (typeof req.body === "string") {
            if (!req.body.trim()) return undefined;
            return JSON.parse(req.body);
        }
        if (typeof req.body === "object" && req.body !== null) return req.body;
        return undefined;
    }
    const raw = await new Promise<string>((resolve, reject) => {
        let buf = "";
        req.on("data", (chunk) => {
            buf += chunk;
        });
        req.on("end", () => resolve(buf));
        req.on("error", reject);
    });
    if (!raw.trim()) return undefined;
    return JSON.parse(raw);
};

export const mcp = (app: any) => {
    const srv = create_mcp_srv();
    const trans = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    const srv_ready = srv
        .connect(trans)
        .then(() => {
            console.error("[MCP] Server started and transport connected");
        })
        .catch((error) => {
            console.error("[MCP] Failed to initialize transport:", error);
            throw error;
        });

    const handle_req = async (req: IncomingMessage, res: ServerResponse) => {
        try {
            await srv_ready;
            const pay = await extract_pay(req);
            if (!pay || typeof pay !== "object") {
                send_err(res, -32600, "Request body must be a JSON object");
                return;
            }
            console.error("[MCP] Incoming request:", JSON.stringify(pay));
            set_hdrs(res);
            await trans.handleRequest(req, res, pay);
        } catch (error) {
            console.error("[MCP] Error handling request:", error);
            if (error instanceof SyntaxError) {
                send_err(res, -32600, "Invalid JSON payload");
                return;
            }
            if (!res.headersSent)
                send_err(
                    res,
                    -32603,
                    "Internal server error",
                    (error as any)?.id ?? null,
                    500,
                );
        }
    };

    app.post("/mcp", (req: IncomingMessage, res: ServerResponse) => {
        void handle_req(req, res);
    });
    app.options("/mcp", (_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = 204;
        set_hdrs(res);
        res.end();
    });

    const method_not_allowed = (_req: IncomingMessage, res: ServerResponse) => {
        send_err(
            res,
            -32600,
            "Method not supported. Use POST  /mcp with JSON payload.",
            null,
            405,
        );
    };
    app.get("/mcp", method_not_allowed);
    app.delete("/mcp", method_not_allowed);
    app.put("/mcp", method_not_allowed);
};

export const start_mcp_stdio = async () => {
    const srv = create_mcp_srv();
    const trans = new StdioServerTransport();
    await srv.connect(trans);
    // console.error("[MCP] STDIO transport connected"); // Use stderr for debug output, not stdout
};

if (import.meta.main) {
    void start_mcp_stdio().catch((error) => {
        console.error("[MCP] STDIO startup failed:", error);
        process.exitCode = 1;
    });
}
