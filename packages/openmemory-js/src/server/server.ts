import * as fs from "fs";
import * as path from "path";
import { parse } from "url";
import { env } from "../core/cfg";
import { sendError } from "./errors";

export interface ServerConfig {
    max_payload_size?: number;
}

export interface AdvancedRequest extends Request {
    query: Record<string, string | string[] | undefined>;
    path: string;
    hostname: string;
    ip: string;
    params: Record<string, string>;
    body: any;
    user?: { id: string; name?: string; role?: string };
    // Node.js compatibility stubs usually not needed if we type carefully, 
    // but some middleware might check headers in a node-way.
    headers: any;
    method: string;
    url: string;
}

export interface AdvancedResponse {
    // We need to mimic the API used by handlers: status(), json(), send(), set(), end()
    // and store the result to be returned by Bun.serve
    status: (code: number) => AdvancedResponse;
    json: (body: any) => void;
    send: (body: any) => void;
    set: (key: string, value: string) => AdvancedResponse;
    setHeader: (key: string, value: string) => void;
    end: (body?: any) => void;
    writeHead: (code: number, headers?: any) => void;
    statusCode: number;
    writableEnded: boolean;
    _body: any;
    _headers: Headers;
}

export type NextFunction = (err?: any) => void;
export type Handler = (req: AdvancedRequest, res: AdvancedResponse, next: NextFunction) => void | Promise<void>;

interface Route {
    method: string;
    path: string;
    handler: Handler;
}

export default function server(config: ServerConfig = {}) {
    const ROUTES: Route[] = [];
    const WARES: Handler[] = [];

    const matchRoute = (method: string, url: string): { handler: Handler; params: Record<string, string> } | null => {
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

            if (matched) return { handler: r.handler, params };
        }
        return null;
    };

    const add = (method: string, path: string, handler: Handler) => {
        ROUTES.push({ method: method.toUpperCase(), path, handler });
    };

    const serverStatic = (endpoint: string, dir: string) => {
        const absDir = path.resolve(dir);
        // We can do this check once at startup
        if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
            console.error(`[STATIC] Directory not found: ${absDir}`);
            return (req: AdvancedRequest, res: AdvancedResponse, next: NextFunction) => next();
        }

        const base = endpoint.endsWith("/") ? endpoint : endpoint + "/";

        return async (req: AdvancedRequest, res: AdvancedResponse, next: NextFunction) => {
            if (req.method !== "GET" && req.method !== "HEAD") return next();
            if (!req.path.startsWith(base)) return next();

            const subPath = req.path.substring(base.length);
            const targetPath = path.join(absDir, subPath);
            const rel = path.relative(absDir, targetPath);

            if (!(rel && !rel.startsWith("..") && !path.isAbsolute(rel))) return next();

            // Bun.file check
            const file = Bun.file(targetPath);
            if (await file.exists()) {
                // Direct response override for static files
                // We need a special signal or just set the body directly.
                // Our adapter allows setting _body.
                res.status(200);
                res.set("Content-Type", file.type);
                // We can't easily stream a Bun.file through our `json/send` adapter 
                // without loading it all. 
                // But Bun.serve returns Response. 
                // So we set `_body` to the file object itself!
                res._body = file;
                res.writableEnded = true;
                return;
            }
            next();
        };
    };

    return {
        use: (handler: Handler) => WARES.push(handler),

        listen: (port: number, cb?: () => void) => {
            const instance = Bun.serve({
                port,
                maxRequestBodySize: config.max_payload_size || 1_000_000,
                development: env.mode === "dev",
                async fetch(req: Request) {
                    const urlObj = new URL(req.url);

                    // 1. Adapter Request
                    const agReq = req as unknown as AdvancedRequest;
                    agReq.path = urlObj.pathname;
                    agReq.query = Object.fromEntries(urlObj.searchParams);
                    agReq.hostname = urlObj.hostname;
                    agReq.ip = instance.requestIP(req)?.address || "127.0.0.1";
                    agReq.params = {};
                    agReq.headers = Object.fromEntries(req.headers);
                    agReq.url = req.url; // Node compatibility

                    // Body parsing (lazy) - handled by middleware or manually
                    // We'll read it once if needed.
                    if (req.headers.get("content-type")?.includes("application/json")) {
                        try {
                            agReq.body = await req.json();
                        } catch {
                            agReq.body = null;
                        }
                    } else {
                        agReq.body = null;
                    }

                    // 2. Adapter Response container
                    let resolveResponse: (res: Response) => void;
                    const responsePromise = new Promise<Response>((r) => { resolveResponse = r; });

                    const responseState = {
                        statusCode: 200,
                        headers: new Headers(),
                        body: undefined as any,
                        ended: false
                    };

                    const agRes = {} as AdvancedResponse;

                    // Bind methods
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
                    agRes.json = (body: any) => {
                        if (responseState.ended) return;
                        responseState.headers.set("Content-Type", "application/json");
                        responseState.body = JSON.stringify(body);
                        responseState.ended = true;
                        agRes.writableEnded = true;
                        resolveResponse(new Response(responseState.body, {
                            status: responseState.statusCode,
                            headers: responseState.headers
                        }));
                    };
                    agRes.send = (body: any) => {
                        if (responseState.ended) return;
                        if (typeof body === "object" && !(body instanceof Blob) && !(bodyObjIsFile(body))) {
                            return agRes.json(body);
                        }
                        if (!responseState.headers.has("Content-Type")) {
                            responseState.headers.set("Content-Type", "text/plain");
                        }
                        responseState.body = body;
                        responseState.ended = true;
                        agRes.writableEnded = true;
                        resolveResponse(new Response(body, {
                            status: responseState.statusCode,
                            headers: responseState.headers
                        }));
                    };
                    agRes.end = (body?: any) => {
                        if (responseState.ended) return;
                        if (body) responseState.body = body;
                        responseState.ended = true;
                        agRes.writableEnded = true;
                        resolveResponse(new Response(responseState.body, {
                            status: responseState.statusCode,
                            headers: responseState.headers
                        }));
                    };
                    agRes.writeHead = (code: number, headers?: any) => {
                        agRes.status(code);
                        if (headers) {
                            for (const k in headers) agRes.set(k, headers[k]);
                        }
                    };
                    // Static file bypass
                    Object.defineProperty(agRes, "_body", {
                        set: (v) => {
                            responseState.body = v;
                            if (v && v.constructor.name === "BunFile") {
                                responseState.ended = true;
                                agRes.writableEnded = true;
                                resolveResponse(new Response(v, {
                                    status: responseState.statusCode,
                                    headers: responseState.headers
                                }));
                            }
                        }
                    });

                    // 3. Routing
                    const match = matchRoute(req.method, agReq.path);
                    agReq.params = match ? match.params : {};

                    const chain = [...WARES];
                    if (match) {
                        chain.push(match.handler);
                    } else {
                        // 404
                        chain.push((_req, _res) => {
                            _res.status(404).send("404: Not Found");
                        });
                    }

                    // 4. Execution
                    let i = 0;
                    const next = async (err?: any) => {
                        if (err) {
                            console.error("[SERVER] Error in middleware:", err);
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
                            } catch (e) {
                                next(e);
                            }
                        }
                    };

                    // Start chain
                    next().catch(err => {
                        console.error("[SERVER] Uncaught chain error:", err);
                        if (!responseState.ended) sendError(agRes, err);
                    });

                    return responsePromise;
                }
            });

            // Callback simulation
            if (cb) setTimeout(cb, 0);
        },

        all: (path: string, handler: Handler) => add("ALL", path, handler),
        serverStatic,
        routes: ROUTES,
        getRoutes: () => ROUTES.reduce((acc, { method, path }) => {
            (acc[method] = acc[method] || []).push(path);
            return acc;
        }, {} as Record<string, string[]>),
        get: (path: string, handler: Handler) => add("GET", path, handler),
        post: (path: string, handler: Handler) => add("POST", path, handler),
        put: (path: string, handler: Handler) => add("PUT", path, handler),
        delete: (path: string, handler: Handler) => add("DELETE", path, handler),
        patch: (path: string, handler: Handler) => add("PATCH", path, handler),
        options: (path: string, handler: Handler) => add("OPTIONS", path, handler),
        head: (path: string, handler: Handler) => add("HEAD", path, handler),
        // No-op for ws since we removed it
        ws: (path: string, handler: any) => { console.warn("[SERVER] WS unused in Bun build"); }
    };
}

function bodyObjIsFile(body: any): boolean {
    return body && (body.constructor.name === "BunFile" || typeof body.stream === 'function');
}
