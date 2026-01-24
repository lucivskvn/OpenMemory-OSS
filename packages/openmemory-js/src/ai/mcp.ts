/**
 * @file mcp.ts
 * @description Model Context Protocol (MCP) server implementation for OpenMemory.
 * @audited 2026-01-19
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";

import { env, VERSION } from "../core/cfg";
import { Memory } from "../core/memory";
import { sectorConfigs } from "../core/hsgConfig";
import { type RpcErrorCode } from "../core/types";
import { getEmbeddingInfo } from "../memory/embed";
import { AppError } from "../server/errors";
import { logger } from "../utils/logger";
import {
    registerCoreMemoryTools,
    registerIngestTools,
} from "./mcpToolsCore";
import { registerTemporalGraphTools } from "./mcpToolsTemporal";
import { registerLangGraphTools, registerIdeTools } from "./mcpToolsGraph";
import { registerAdminTools } from "./mcpToolsAdmin";

/**
 * MCP Server version - synchronized with package.json version via core/cfg.
 */
const MCP_VERSION = VERSION;

/**
 * MCP Protocol date - indicates the protocol specification version.
 */
const MCP_PROTOCOL_DATE = "2025-11-25";

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
        let msg = error instanceof Error ? error.message : String(error);
        // Redact potential file paths
        msg = msg.replace(/[a-zA-Z]:\\[\w\\.\-]+/g, "[PATH_REDACTED]")
            .replace(/\/[a-zA-Z0-9_\-\/.]+/g, "[PATH_REDACTED]");
        sendMcpError(res, -32603, `Internal Error: ${msg}`, id, 500);
    }
};

/**
 * Creates and configures the OpenMemory MCP server.
 */
export const createMcpServer = (): McpServer => {
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

    // Register modular toolsets
    registerCoreMemoryTools(srv, mem);
    registerIngestTools(srv, mem);
    registerTemporalGraphTools(srv, mem);
    registerLangGraphTools(srv, mem);
    registerIdeTools(srv, mem);
    registerAdminTools(srv, mem);

    srv.resource(
        "openmemory-config",
        "openmemory://config",
        {
            mimeType: "application/json",
            description: "Runtime configuration snapshot for the OpenMemory MCP server",
        },
        async () => {
            const snapshot = {
                mode: env.mode,
                sectors: sectorConfigs,
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
                    "openmemory_ingest_content",
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
                    "openmemory_admin_audit_query",
                    "openmemory_admin_webhook_create",
                    "openmemory_admin_webhook_list",
                    "openmemory_admin_webhook_delete",
                    "openmemory_admin_webhook_test",
                    "openmemory_admin_metrics",
                    "openmemory_admin_bulk_delete",
                    "openmemory_admin_bulk_update",
                    "openmemory_health_check",
                ],
            };

            try {
                const { get_generator } = await import("./adapters");
                const gen = await get_generator();
                if (gen) {
                    (snapshot as any).active_model = {
                        provider: gen.constructor.name.replace("Generator", ""),
                        model: gen.model,
                    };
                }
            } catch { /* ignore */ }

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

const MAX_PAYLOAD_SIZE = env.maxPayloadSize;

const extractPayload = async (req: IncomingMessage): Promise<unknown> => {
    const body = (req as any).body;
    if (body !== undefined) {
        if (typeof body === "string") {
            if (!body.trim()) return undefined;
            if (body.length > MAX_PAYLOAD_SIZE)
                throw new AppError(400, "BAD_REQUEST", "Payload too large");
            return JSON.parse(body);
        }
        if (typeof body === "object" && body !== null) return body;
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
 * Adapts Elysia/Web Request to Node IncomingMessage for MCP SDK.
 */
class WebToNodeRequest extends ((typeof globalThis.EventTarget) ? globalThis.EventTarget : Object) {
    method: string;
    headers: Record<string, string>;
    url: string;
    body: any;

    constructor(req: Request, body?: any) {
        super();
        this.method = req.method;
        this.headers = {};
        req.headers.forEach((v, k) => { this.headers[k] = v; });
        this.url = new URL(req.url).pathname + new URL(req.url).search;
        this.body = body;
    }
}

/**
 * mcpRoutes: Elysia plugin for MCP Server.
 */
import { Elysia } from "elysia";

export const mcpRoutes = (app: Elysia) => {
    // Singleton MCP Server & Transport instance per app
    const srv = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
    });

    const serverReady = srv.connect(transport)
        .then(() => logger.info("[MCP] Server started and transport connected"))
        .catch(err => {
            logger.error("[MCP] Transport init failed", { error: err });
            throw err;
        });

    return app.group("/mcp", (app) => app
        .all("/", async ({ request, body, set }) => {
            await serverReady;

            // Bridgeless Stream: We create a ReadableStream that transport allows writing to via Mock Response
            const stream = new TransformStream();
            const writer = stream.writable.getWriter();
            const encoder = new TextEncoder();

            // Mock ServerResponse
            const mockRes: any = {
                headers: {} as Record<string, string>,
                statusCode: 200,
                headersSent: false,
                setHeader(k: string, v: string) { this.headers[k] = v; },
                writeHead(code: number, headers?: any) {
                    this.statusCode = code;
                    if (headers) Object.assign(this.headers, headers);
                    this.headersSent = true;
                },
                write(chunk: any) {
                    // Send chunk to stream
                    if (chunk instanceof Uint8Array) writer.write(chunk);
                    else if (typeof chunk === 'string') writer.write(encoder.encode(chunk));
                    else writer.write(encoder.encode(JSON.stringify(chunk)));
                    return true;
                },
                end(chunk: any) {
                    if (chunk) this.write(chunk);
                    writer.close();
                    this.finished = true;
                    return this;
                },
                once() { },
                emit() { },
                on() { }
            };

            // Mock IncomingMessage
            const mockReq = new WebToNodeRequest(request, body) as unknown as IncomingMessage;

            // Handle
            try {
                // If GET, transport might need query params.
                // If POST, transport expects payload.
                let msg = body;
                if (request.method === 'GET' || request.method === 'HEAD') {
                    // transport.handleRequest handles GET for SSE usually
                    msg = undefined;
                } else {
                    if (!msg || typeof msg !== 'object') msg = {}; // Empty object generic
                }

                // Execute Transport Logic
                // We don't await strictly if it streams? 
                // handleRequest usually awaits the processing but writing to res might be async.
                // However, for SSE, it keeps connection open.
                // We must return the Response immediately with the readable stream.

                transport.handleRequest(mockReq, mockRes, msg as any).catch(err => {
                    logger.error("[MCP] Handler Error", { error: err });
                    try { writer.close(); } catch { }
                });

            } catch (err) {
                logger.error("[MCP] Request Error", { error: err });
                writer.close();
            }

            return new Response(stream.readable, {
                status: mockRes.statusCode,
                headers: {
                    ...mockRes.headers,
                    "Content-Type": mockRes.headers["Content-Type"] || "application/json"
                }
            });
        })
    );
};

/**
 * Starts the MCP server using standard I/O (stdio) transport.
 */
export const startMcpStdio = async (): Promise<void> => {
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
