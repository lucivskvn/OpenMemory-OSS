import * as fs from "node:fs";
import * as path from "node:path";

import { env } from "../core/cfg";
/**
 * Server configuration standardized to camelCase.
 */
import { UserContext } from "../core/types";
import { logger } from "../utils/logger";
import { rid } from "../utils";
import { sendError } from "./errors";

/**
 * Server configuration options.
 */
export interface ServerConfig {
    maxPayloadSize?: number;
    cors?: boolean | { origin: string };
    logging?: boolean;
}

/**
 * Request object extended with Express-like conveniences.
 * Used internally by the OpenMemory server router.
 */
export interface AdvancedRequest extends Omit<Request, "headers" | "body"> {
    /** Parsed query parameters from the URL. Can be mutated by validation middleware (e.g. Zod). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: Record<string, string | string[] | undefined> | any;
    /** The URL path (pathname) */
    path: string;
    /** The hostname derived from the URL */
    hostname: string;
    /** The client IP address */
    ip: string;
    /** Route parameters (e.g. /users/:id) populated by the router */
    params: Record<string, string>;
    /** json body, populated if Content-Type is application/json */
    body: unknown;
    /** Header map */
    headers: Record<string, string | string[] | undefined>;
    /** HTTP Method */
    method: string;
    /** Full URL */
    url: string;
    /** Unique request identifier for traceability */
    requestId: string;
    /** Authenticated user context, if populated by auth middleware */
    user?: UserContext;
}

/**
 * Response helper object providing Express-like methods.
 * Wraps Bun's Response generation logic.
 */
export interface AdvancedResponse {
    /** Sets the HTTP status code */
    status: (code: number) => AdvancedResponse;
    /** Sends a JSON response and ends the request */
    json: (body: unknown) => void;
    /** Sends a response (string, object, or Buffer) */
    send: (body: unknown) => void;
    /** Sets a response header */
    set: (key: string, value: string) => AdvancedResponse; // Chainable
    /** Sets a response header (Void return) */
    setHeader: (key: string, value: string) => void;
    /** Ends the response optionally with a body */
    end: (body?: unknown) => void;
    /** Set status and headers (Node.js compatibility stub) */
    writeHead: (code: number, headers?: Record<string, string>) => void;
    /** Current status code */
    statusCode: number;
    /** Whether the response has been finalized */
    writableEnded?: boolean;
    /** Internal body reference */
    _body?: unknown;
    /** Internal headers reference */
    _headers: Headers;
}

export type NextFunction = (err?: unknown) => void;
export type Handler = (
    req: AdvancedRequest,
    res: AdvancedResponse,
    next: NextFunction,
) => void | Promise<void>;

export interface Route {
    method: string;
    path: string;
    handlers: Handler[];
}

/**
 * Interface defining the minimal server API exposed to the application.
 * Abstraction layer over Bun.serve to allow potential future swaps or mocking.
 */
export interface ServerApp {
    /** Register global middleware */
    use: (handler: Handler) => void;
    /** Start the server on the specified port */
    listen: (
        port: number | string,
        cb?: () => void,
    ) => import("bun").Server<unknown>;

    // HTTP Method Handlers
    all: (path: string, ...handlers: Handler[]) => void;
    serverStatic: (endpoint: string, dir: string) => Handler;
    routes: Route[];
    getRoutes: () => Record<string, string[]>;
    get: (path: string, ...handlers: Handler[]) => void;
    post: (path: string, ...handlers: Handler[]) => void;
    put: (path: string, ...handlers: Handler[]) => void;
    delete: (path: string, ...handlers: Handler[]) => void;
    patch: (path: string, ...handlers: Handler[]) => void;
    options: (path: string, ...handlers: Handler[]) => void;
    head: (path: string, ...handlers: Handler[]) => void;
    ws: (path: string, handler: unknown) => void;
    fetch: (req: Request, server: import("bun").Server<unknown>) => Promise<Response>;
    /** Stop the server, closing all active connections and ensuring graceful cleanup. */
    stop: () => void | Promise<void>;
}

/**
 * Optimized lightweight server built on Bun.serve.
 * Purposefully minimal to reduce overhead for edge deployments.
 * 
 * **Lifecycle**:
 * 1. `server()` factory creates a new app instance.
 * 2. Routes definitions are pushed to `ROUTES` array (lazy registration).
 * 3. `listen()` initializes `Bun.serve` with `fetchHandler`.
 * 4. `fetchHandler` maps standard `Request` to `AdvancedRequest`, executes middleware chain, then route handlers.
 * 
 * @param config Server configuration options (payload limits, etc.)
 */
export default function server(config: ServerConfig = {}): ServerApp {
    const ROUTES: Route[] = [];
    const WARES: Handler[] = [];

    const matchRoute = (
        method: string,
        url: string,
    ): { handlers: Handler[]; params: Record<string, string> } | null => {
        for (const r of ROUTES) {
            if (r.method !== method && r.method !== "ALL") continue;

            const p = r.path.split("/").filter(Boolean);
            const u = url.split("/").filter(Boolean);
            if (p.length !== u.length) continue;

            const params: Record<string, string> = {};
            let matched = true;

            for (let j = 0; j < p.length; j++) {
                if (p[j].startsWith(":")) {
                    params[p[j].slice(1)] = decodeURIComponent(u[j]);
                } else if (p[j] !== u[j]) {
                    matched = false;
                    break;
                }
            }

            if (matched) {
                return { handlers: r.handlers, params };
            }
        }
        return null;
    };

    const add = (method: string, path: string, ...handlers: Handler[]) => {
        ROUTES.push({ method: method.toUpperCase(), path, handlers });
    };

    const serverStatic = (endpoint: string, dir: string) => {
        const absDir = path.resolve(dir);
        if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
            logger.error(`[STATIC] Directory not found: ${absDir}`);
            return (
                _req: AdvancedRequest,
                _res: AdvancedResponse,
                next: NextFunction,
            ) => next();
        }

        const base = endpoint.endsWith("/") ? endpoint : endpoint + "/";

        return async (
            req: AdvancedRequest,
            res: AdvancedResponse,
            next: NextFunction,
        ) => {
            if (req.method !== "GET" && req.method !== "HEAD") return next();
            if (!req.path.startsWith(base)) return next();

            const subPath = req.path.substring(base.length);
            const targetPath = path.join(absDir, subPath);
            const rel = path.relative(absDir, targetPath);

            if (!(rel && !rel.startsWith("..") && !path.isAbsolute(rel)))
                return next();

            const file = Bun.file(targetPath);
            if (await file.exists()) {
                res.status(200);
                res.set("Content-Type", file.type);
                res.set("Cache-Control", "public, max-age=3600"); // 1 hour cache
                res._body = file;
                res.writableEnded = true;
                return;
            }
            next();
        };
    };

    const fetchHandler = async (req: Request, server: import("bun").Server<unknown>) => {
        const urlObj = new URL(req.url);

        // Cast to AdvancedRequest and populate properties
        const agReq = req as unknown as AdvancedRequest;

        const props: Record<string, unknown> = {
            path: urlObj.pathname,
            query: Object.fromEntries(urlObj.searchParams),
            hostname: urlObj.hostname,
            ip: server?.requestIP?.(req)?.address || "127.0.0.1",
            params: {},
            headers: Object.fromEntries(req.headers),
            requestId: rid(),
            body: null,
        };

        for (const [key, value] of Object.entries(props)) {
            Object.defineProperty(agReq, key, {
                value,
                writable: true,
                enumerable: true,
                configurable: true,
            });
        }

        // Handle JSON body parsing
        const h = agReq.headers || {};
        const contentType = (
            (h["content-type"] || h["Content-Type"] || "") as string
        ).toLowerCase();
        const hasBody =
            req.method !== "GET" &&
            req.method !== "HEAD" &&
            (h["content-length"] ||
                h["transfer-encoding"] ||
                req.body !== null);

        if (contentType.includes("application/json") && hasBody) {
            try {
                // Buffer to avoid multiple req.json() calls if needed
                const json = await req.json();
                agReq.body = json;
                if (env.verbose)
                    logger.debug("[SERVER] JSON Body parsed:", { body: json });
            } catch (e: unknown) {
                const err = e as Error;
                // If it's just an empty body, don't 400
                if (
                    err.message?.includes("Unexpected end of JSON input") ||
                    err.message?.includes("Body is empty")
                ) {
                    agReq.body = null;
                } else {
                    logger.warn("[SERVER] JSON parse failed:", { error: e });
                    return new globalThis.Response(
                        JSON.stringify({ error: "Invalid JSON" }),
                        {
                            status: 400,
                            headers: { "Content-Type": "application/json" },
                        },
                    );
                }
            }
        } else {
            agReq.body = null;
        }

        let resolveResponse: (res: Response) => void;
        const responsePromise = new Promise<Response>((resolve) => {
            resolveResponse = resolve;
        });

        const responseState = {
            statusCode: 200,
            headers: new Headers(),
            body: undefined as unknown,
            ended: false,
        };

        const agRes = {} as AdvancedResponse;

        agRes.status = (code: number) => {
            responseState.statusCode = code;
            agRes.statusCode = code;
            return agRes;
        };
        agRes.statusCode = 200;
        agRes.set = (k: string, v: string) => {
            responseState.headers.set(k, v);
            return agRes;
        };
        agRes.setHeader = agRes.set;
        agRes.json = (body: unknown) => {
            if (responseState.ended) return;

            try {
                const json = JSON.stringify(body, (_key, value) =>
                    typeof value === "bigint" ? value.toString() : value,
                );

                responseState.headers.set("Content-Type", "application/json");
                responseState.body = json;
                responseState.ended = true;
                agRes.writableEnded = true;

                resolveResponse(
                    globalThis.Response.json(body, {
                        status: responseState.statusCode,
                        headers: responseState.headers,
                    }),
                );
            } catch (e) {
                logger.error("[SERVER] JSON serialization failed:", {
                    error: e,
                });
                if (responseState.statusCode === 200) {
                    responseState.statusCode = 500;
                }
                responseState.headers.set("Content-Type", "application/json");
                responseState.body = JSON.stringify({
                    error: "serialization_error",
                    message: String(e),
                });
                responseState.ended = true;
                agRes.writableEnded = true;
                resolveResponse(
                    new globalThis.Response(responseState.body as BodyInit, {
                        status: responseState.statusCode,
                        headers: responseState.headers,
                    }),
                );
            }
        };
        agRes.send = (body: unknown) => {
            if (responseState.ended) return;
            if (
                typeof body === "object" &&
                body !== null &&
                !(body instanceof Blob) &&
                !bodyObjIsFile(body)
            ) {
                return agRes.json(body);
            }
            if (!responseState.headers.has("Content-Type")) {
                responseState.headers.set("Content-Type", "text/plain");
            }
            responseState.body = body;
            responseState.ended = true;
            agRes.writableEnded = true;

            resolveResponse(
                new globalThis.Response(body as BodyInit, {
                    status: responseState.statusCode,
                    headers: responseState.headers,
                }),
            );
        };
        agRes.end = (body?: unknown) => {
            if (responseState.ended) return;
            if (body) {
                responseState.body = body;
                if (
                    typeof body === "string" &&
                    !responseState.headers.has("Content-Type")
                ) {
                    responseState.headers.set("Content-Type", "text/plain");
                }
            }
            responseState.ended = true;
            agRes.writableEnded = true;
            resolveResponse(
                new globalThis.Response(responseState.body as BodyInit, {
                    status: responseState.statusCode,
                    headers: responseState.headers,
                }),
            );
        };
        agRes.writeHead = (code: number, headers?: Record<string, string>) => {
            agRes.status(code);
            if (headers) {
                for (const k in headers) agRes.set(k, headers[k]);
            }
        };
        Object.defineProperty(agRes, "_body", {
            set: (v) => {
                responseState.body = v;
                if (v && v.constructor.name === "BunFile") {
                    responseState.ended = true;
                    agRes.writableEnded = true;
                    resolveResponse(
                        new globalThis.Response(v, {
                            status: responseState.statusCode,
                            headers: responseState.headers,
                        }),
                    );
                }
            },
        });

        const match = matchRoute(req.method, agReq.path);
        agReq.params = match ? match.params : {};

        const chain: Handler[] = [...WARES];
        if (match) {
            agReq.params = match.params;
            chain.push(...match.handlers);
        } else {
            // Middleware signature requires args, prefix with _ if unused
            chain.push((_req, _res, _next) => {
                _res.status(404).send("404: Not Found");
            });
        }

        // Default Middleware: Security Headers & CORS
        chain.unshift(async (req, res, next) => {
            res.set("X-Content-Type-Options", "nosniff");
            res.set("X-Frame-Options", "DENY");
            res.set("Referrer-Policy", "strict-origin-when-cross-origin");

            if (config.cors !== false) {
                const origin = typeof config.cors === "object" ? config.cors.origin : "*";
                res.set("Access-Control-Allow-Origin", origin);
                res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
                res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

                if (req.method === "OPTIONS") {
                    res.status(204).end();
                    return;
                }
            }
            if (config.logging !== false) {
                const start = performance.now();
                // Hook into end to log duration
                const origEnd = res.end;
                res.end = (body?: unknown) => {
                    const dur = performance.now() - start;
                    logger.info(`[HTTP] ${req.method} ${req.path} ${res.statusCode} ${dur.toFixed(2)}ms`);
                    origEnd(body);
                };
            }

            // Cloudflare / Caching Optimization
            if (req.path.startsWith("/api") || req.path.startsWith("/mcp") || req.path.startsWith("/stream")) {
                // MCP and API must be real-time
                res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
                res.set("Pragma", "no-cache");
                res.set("Expires", "0");
            } else if (req.path.startsWith("/dashboard") && (req.path.endsWith(".js") || req.path.endsWith(".css") || req.path.endsWith(".png"))) {
                // Static assets can be cached
                res.set("Cache-Control", "public, max-age=3600");
            }

            next();
        });

        let i = 0;
        const next = async (err?: unknown) => {
            if (err) {
                logger.error(`[SERVER] Error in ${req.method} ${agReq.path}:`, {
                    error: err,
                });
                if (!responseState.ended) {
                    sendError(agRes, err);
                }
                return;
            }
            if (responseState.ended) return;

            if (i < chain.length) {
                const fn = chain[i++];
                try {
                    await fn(agReq, agRes, next);
                } catch (e: unknown) {
                    await next(e);
                }
            }
        };

        // Start the chain
        void next().catch((err) => {
            logger.error("[SERVER] Uncaught chain error:", { error: err });
            if (!responseState.ended) sendError(agRes, err);
        });

        return await responsePromise;
    };



    let bunServer: import("bun").Server<unknown> | undefined;

    /**
     * Gracefully stops the server instance.
     * Forcefully closes connections if they hang.
     */

    const stop = async () => {
        if (bunServer) {
            await bunServer.stop(true); // true = forceful close if needed, or false for graceful
            bunServer = undefined;
            logger.info("[SERVER] Server stopped.");
        }
    };

    return {
        use: (handler: Handler) => WARES.push(handler),

        listen: (port: number | string, cb?: () => void) => {
            const instance = Bun.serve<unknown>({
                maxRequestBodySize: config.maxPayloadSize || 1_000_000,
                port: Number(port) || 3000,
                development: env.mode === "dev",
                websocket: {
                    message: () => { },
                    open: () => { },
                    close: () => { },
                    drain: () => { },
                },
                fetch: fetchHandler,
            });
            bunServer = instance;

            if (cb) setTimeout(cb, 0);
            return instance;
        },

        all: (path: string, ...handlers: Handler[]) =>
            add("ALL", path, ...handlers),
        serverStatic,
        routes: ROUTES,
        getRoutes: () =>
            ROUTES.reduce(
                (acc, { method, path }) => {
                    (acc[method] = acc[method] || []).push(path);
                    return acc;
                },
                {} as Record<string, string[]>,
            ),
        get: (path: string, ...handlers: Handler[]) =>
            add("GET", path, ...handlers),
        post: (path: string, ...handlers: Handler[]) =>
            add("POST", path, ...handlers),
        put: (path: string, ...handlers: Handler[]) =>
            add("PUT", path, ...handlers),
        delete: (path: string, ...handlers: Handler[]) =>
            add("DELETE", path, ...handlers),
        patch: (path: string, ...handlers: Handler[]) =>
            add("PATCH", path, ...handlers),
        options: (path: string, ...handlers: Handler[]) =>
            add("OPTIONS", path, ...handlers),
        head: (path: string, ...handlers: Handler[]) =>
            add("HEAD", path, ...handlers),
        fetch: fetchHandler,
        ws: (_path: string, _handler: unknown) => {
            logger.warn("[SERVER] WS unused in Bun build");
        },
        stop,
    };
}

/**
 * Checks if a body object is a transferable stream or BunFile.
 */
function bodyObjIsFile(body: unknown): boolean {
    return !!(
        body &&
        typeof body === "object" &&
        "constructor" in body &&
        (body.constructor.name === "BunFile" ||
            body.constructor.name === "ReadableStream" ||
            typeof (body as Record<string, unknown>).stream === "function")
    );
}
