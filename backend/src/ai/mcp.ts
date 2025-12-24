// ... imports ...
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage, JSONRPCResponse } from "@modelcontextprotocol/sdk/types.js";
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
import { getEmbeddingInfo } from "../memory/embed";
import { j, p } from "../utils";
import type { sector_type, mem_row } from "../core/types";
import { update_user_summary } from "../memory/user_summary";
import { Elysia } from "elysia";
import { log } from "../core/log";
import crypto from "node:crypto";

const sec_enum = z.enum([
    "episodic",
    "semantic",
    "procedural",
    "emotional",
    "reflective",
] as const);

const trunc = (val: string, max = 200) =>
    val.length <= max ? val : `${val.slice(0, max).trimEnd()}...`;

const build_mem_snap = (row: mem_row) => ({
    id: row.id,
    primary_sector: row.primary_sector,
    salience: Number(row.salience.toFixed(3)),
    last_seen_at: row.last_seen_at,
    user_id: row.user_id,
    content_preview: trunc(row.content, 240),
});

const fmt_matches = (matches: Awaited<ReturnType<typeof hsg_query>>) =>
    matches
        .map((m: any, idx: any) => {
            const prev = trunc(m.content.replace(/\s+/g, " ").trim(), 200);
            return `${idx + 1}. [${m.primary_sector}] score=${m.score.toFixed(3)} salience=${m.salience.toFixed(3)} id=${m.id}\n${prev}`;
        })
        .join("\n\n");

const uid = (val?: string | null) => (val?.trim() ? val.trim() : undefined);

export const create_mcp_srv = () => {
    // ... same content as before ...
    const srv = new McpServer(
        {
            name: "openmemory-mcp",
            version: "2.1.0",
        },
        { capabilities: { tools: {}, resources: {}, logging: {} } },
    );

    srv.tool(
        "openmemory_query",
        "Run a semantic retrieval against OpenMemory",
        {
            query: z.string().min(1, "query text is required").describe("Free-form search text"),
            k: z.number().int().min(1).max(32).default(8).describe("Maximum results to return"),
            sector: sec_enum.optional().describe("Restrict search to a specific sector"),
            min_salience: z.number().min(0).max(1).optional().describe("Minimum salience threshold"),
            user_id: z.string().trim().min(1).optional().describe("Isolate results to a specific user identifier"),
        },
        async ({ query, k, sector, min_salience, user_id }) => {
            const u = uid(user_id);
            const flt = sector || min_salience !== undefined || u
                    ? {
                        ...(sector ? { sectors: [sector as sector_type] } : {}),
                        ...(min_salience !== undefined ? { minSalience: min_salience } : {}),
                        ...(u ? { user_id: u } : {}),
                    }
                    : undefined;
            const matches = await hsg_query(query, k ?? 8, flt);
            const summ = matches.length ? fmt_matches(matches) : "No memories matched the supplied query.";
            const pay = matches.map((m: any) => ({
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
                    { type: "text", text: summ },
                    { type: "text", text: JSON.stringify({ query, matches: pay }, null, 2) },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_store",
        "Persist new content into OpenMemory",
        {
            content: z.string().min(1).describe("Raw memory text to store"),
            tags: z.array(z.string()).optional().describe("Optional tag list"),
            metadata: z.record(z.any()).optional().describe("Arbitrary metadata blob"),
            user_id: z.string().trim().min(1).optional().describe("Associate the memory with a specific user identifier"),
        },
        async ({ content, tags, metadata, user_id }) => {
            const u = uid(user_id);
            const res = await add_hsg_memory(content, j(tags || []), metadata, u);
            if (u) update_user_summary(u).catch((err) => log.error("[MCP] user summary update failed:", { error: err }));
            const txt = `Stored memory ${res.id} (primary=${res.primary_sector}) across sectors: ${res.sectors.join(", ")}${u ? ` [user=${u}]` : ""}`;
            const payload = {
                id: res.id,
                primary_sector: res.primary_sector,
                sectors: res.sectors,
                user_id: u ?? null,
            };
            return {
                content: [
                    { type: "text", text: txt },
                    { type: "text", text: JSON.stringify(payload, null, 2) },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_reinforce",
        "Boost salience for an existing memory",
        {
            id: z.string().min(1).describe("Memory identifier to reinforce"),
            boost: z.number().min(0.01).max(1).default(0.1).describe("Salience boost amount (default 0.1)"),
        },
        async ({ id, boost }) => {
            await reinforce_memory(id, boost);
            return {
                content: [
                    { type: "text", text: `Reinforced memory ${id} by ${boost}` },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_list",
        "List recent memories for quick inspection",
        {
            limit: z.number().int().min(1).max(50).default(10).describe("Number of memories to return"),
            sector: sec_enum.optional().describe("Optionally limit to a sector"),
            user_id: z.string().trim().min(1).optional().describe("Restrict results to a specific user identifier"),
        },
        async ({ limit, sector, user_id }) => {
            const u = uid(user_id);
            let rows: mem_row[];
            if (u) {
                const all = await q.all_mem_by_user.all(u, limit ?? 10, 0);
                rows = sector ? all.filter((row) => row.primary_sector === sector) : all;
            } else {
                rows = sector ? await q.all_mem_by_sector.all(sector, limit ?? 10, 0) : await q.all_mem.all(limit ?? 10, 0);
            }
            const items = rows.map((row) => ({
                ...build_mem_snap(row),
                tags: p(row.tags || "[]") as string[],
                metadata: p(row.meta || "{}") as Record<string, unknown>,
            }));
            const lns = items.map(
                (item, idx) =>
                    `${idx + 1}. [${item.primary_sector}] salience=${item.salience} id=${item.id}${item.tags.length ? ` tags=${item.tags.join(", ")}` : ""}${item.user_id ? ` user=${item.user_id}` : ""}\n${item.content_preview}`,
            );
            return {
                content: [
                    { type: "text", text: lns.join("\n\n") || "No memories stored yet." },
                    { type: "text", text: JSON.stringify({ items }, null, 2) },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_get",
        "Fetch a single memory by identifier",
        {
            id: z.string().min(1).describe("Memory identifier to load"),
            include_vectors: z.boolean().default(false).describe("Include sector vector metadata"),
            user_id: z.string().trim().min(1).optional().describe("Validate ownership against a specific user identifier"),
        },
        async ({ id, include_vectors, user_id }) => {
            const u = uid(user_id);
            const mem = await q.get_mem.get(id);
            if (!mem) return { content: [{ type: "text", text: `Memory ${id} not found.` }] };
            if (u && mem.user_id !== u) return { content: [{ type: "text", text: `Memory ${id} not found for user ${u}.` }] };
            const vecs = include_vectors ? await vector_store.getVectorsById(id) : [];
            const pay = {
                id: mem.id,
                content: mem.content,
                primary_sector: mem.primary_sector,
                salience: mem.salience,
                decay_lambda: mem.decay_lambda,
                created_at: mem.created_at,
                updated_at: mem.updated_at,
                last_seen_at: mem.last_seen_at,
                user_id: mem.user_id,
                tags: p(mem.tags || "[]"),
                metadata: p(mem.meta || "{}"),
                sectors: include_vectors ? vecs.map((v) => v.sector) : undefined,
            };
            return {
                content: [{ type: "text", text: JSON.stringify(pay, null, 2) }],
            };
        },
    );

    srv.resource(
        "openmemory-config",
        "openmemory://config",
        {
            mimeType: "application/json",
            description: "Runtime configuration snapshot for the OpenMemory MCP server",
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
                ],
            };
            return {
                contents: [
                    { uri: "openmemory://config", text: JSON.stringify(pay, null, 2) },
                ],
            };
        },
    );

    srv.server.oninitialized = () => {
        log.info(
            "[MCP] initialization completed with client:",
            { version: srv.server.getClientVersion() },
        );
    };
    return srv;
};

// Custom transport for Elysia (Bun)
class ElysiaSSETransport implements Transport {
    private _sessionId: string;
    private _push: (event: string, data: string) => void;

    onmessage?: (message: JSONRPCMessage) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;

    constructor(push: (event: string, data: string) => void, sessionId?: string) {
        this._push = push;
        this._sessionId = sessionId || crypto.randomUUID();
    }

    async start(): Promise<void> {
        this._push("endpoint", `/api/mcp/message?sessionId=${this._sessionId}`);
    }

    async close(): Promise<void> {
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this._push("message", JSON.stringify(message));
    }

    async handleMessage(message: JSONRPCMessage): Promise<void> {
        this.onmessage?.(message);
    }

    get sessionId() {
        return this._sessionId;
    }
}

const transports = new Map<string, ElysiaSSETransport>();

export const mcp = (app: Elysia) => {
    log.info("[MCP] Registering MCP routes...");
    return app.group("/api/mcp", (app) =>
        app
            .get("/sse", async ({ request, set }) => {
                log.info("[MCP] SSE Connection Requested");
                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const encoder = new TextEncoder();

                const push = (event: string, data: string) => {
                    writer.write(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
                };

                const srv = create_mcp_srv();
                const transport = new ElysiaSSETransport(push);
                transports.set(transport.sessionId, transport);

                srv.connect(transport).catch(e => log.error("MCP Connect Error:", { error: e }));

                request.signal.addEventListener("abort", () => {
                    transport.close();
                    transports.delete(transport.sessionId);
                    writer.close();
                });

                return new Response(readable, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                    }
                });
            })
            .post("/message", async ({ query, body, set }) => {
                const sessionId = query.sessionId as string;
                const transport = transports.get(sessionId);

                if (!transport) {
                    set.status = 404;
                    return "Session not found";
                }

                try {
                    await transport.handleMessage(body as JSONRPCMessage);
                    return "Accepted";
                } catch (e: any) {
                    set.status = 500;
                    return e.message;
                }
            })
    );
};

export const start_mcp_stdio = async () => {
    const srv = create_mcp_srv();
    const trans = new StdioServerTransport();
    await srv.connect(trans);
};

if (import.meta.main) {
    void start_mcp_stdio().catch((error) => {
        log.error("[MCP] STDIO startup failed:", { error });
        process.exitCode = 1;
    });
}
