import { Server, ServeOptions, WebSocketHandler } from "bun";
import { env } from '../core/cfg';
import logger from '../core/logger';

export type Context = {
    params: Record<string, string>;
    query: URLSearchParams;
    body?: any;
    [key: string]: any;
};

type Middleware = (
    req: Request,
    ctx: Context,
    next: () => Promise<Response>,
) => Promise<Response>;

// Legacy response adapter shape used by many existing handlers. Keep a
// typed surface so we can avoid `any` in server internals.
// RouteHandler accepts (req, ctx) and must return a Response (or Promise<Response>).
type RouteHandler = (req: Request, ctx: Context) => Response | Promise<Response>;

type WebSocketRouteHandler = WebSocketHandler<{url: URL}>;

type Route = {
    method: string;
    path: string;
    handler: RouteHandler;
};

type WebSocketRoute = {
    path: string;
    handler: WebSocketRouteHandler;
};

export function createServer(config: { max_payload_size?: number } = {}) {
    const middlewares: Middleware[] = [];
    const routes: Route[] = [];
    const ws_routes: WebSocketRoute[] = [];

    // WebSocket data injected into the server upgrade context
    interface WebSocketData {
        url: URL;
    }

    let server: Server<WebSocketData>;

    const app = {
        use(middleware: Middleware) {
            middlewares.push(middleware);
        },
        add(method: string, path: string, handler: RouteHandler) {
             routes.push({ method: method.toUpperCase(), path, handler });
        },
        get(path: string, handler: RouteHandler) { this.add("GET", path, handler) },
        post(path: string, handler: RouteHandler) { this.add("POST", path, handler) },
        put(path: string, handler: RouteHandler) { this.add("PUT", path, handler) },
        delete(path: string, handler: RouteHandler) { this.add("DELETE", path, handler) },
        patch(path: string, handler: RouteHandler) { this.add("PATCH", path, handler) },
        options(path: string, handler: RouteHandler) { this.add("OPTIONS", path, handler) },

        ws(path: string, handler: WebSocketRouteHandler) {
            ws_routes.push({ path, handler });
        },

        listen(port: number, callback?: () => void) {
            const fetch = async (req: Request): Promise<Response> => {
                const url = new URL(req.url);

                // WebSocket upgrade
                if (req.headers.get("upgrade") === "websocket") {
                    const ws_route = ws_routes.find((r) => r.path === url.pathname);
                    if (ws_route) {
                        // Let Bun perform the 101 handshake implicitly when upgrade succeeds.
                        // server.upgrade returns true on success. In that case return
                        // undefined so Bun completes the upgrade. On failure return 500.
                        if ((server as any).upgrade(req, { data: { url } })) {
                            return undefined as any;
                        }
                        return new Response("WebSocket upgrade failed", { status: 500 });
                    }
                }

                const { handler, params } = this.matchRoute(req.method, url.pathname);

                if (!handler) {
                    return new Response("Not Found", { status: 404 });
                }

                const ctx: Context = {
                    params,
                    query: url.searchParams,
                };

                // Call handlers with (req, ctx). Handlers must return a Response.

                // Body parsing middleware: parse JSON when Content-Type indicates JSON.
                const contentType = (req.headers.get("content-type") || "").toLowerCase();
                if (contentType.includes("application/json")) {
                    const len = Number(req.headers.get("content-length") || 0);
                    if (config.max_payload_size && len > config.max_payload_size) {
                        return new Response("Payload Too Large", { status: 413 });
                    }
                    try {
                        ctx.body = await req.json();
                    } catch (e) {
                        return new Response("Invalid JSON", { status: 400 });
                    }
                }

                const runner = async (index: number): Promise<Response> => {
                    if (index < middlewares.length) {
                        return middlewares[index](req, ctx, () => runner(index + 1));
                    }

                    // Determine whether this handler is a legacy Express-style handler.
                    // To avoid re-invoking route code, only call the handler in legacy
                    // mode if it's explicitly marked or the global migration flag is set.
                    const isExplicitLegacy = (handler as any).__legacy === true;
                    const globalLegacyMode = process.env.OM_LEGACY_HANDLER_MODE === 'true';

                    // Legacy res shim (used only when legacy mode is enabled)
                    const makeResShim = () => {
                        const headers = new Headers();
                        let status = 200;
                        let body: any = null;
                        const resShim: any = {
                            status(code: number) { status = code; return resShim; },
                            setHeader(name: string, value: string) { headers.set(name, value); },
                            getHeader(name: string) { return headers.get(name); },
                            json(obj: any) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(obj); },
                            send(val: any) { body = typeof val === 'string' ? val : JSON.stringify(val); },
                            end(val?: any) { if (val !== undefined) body = val; },
                        };
                        return { resShim, headers, getStatusBody: () => ({ status, body }) };
                    };

                    // If explicit legacy marker or global mode enabled, call as legacy once.
                    if (isExplicitLegacy || globalLegacyMode) {
                        const { resShim, headers, getStatusBody } = makeResShim();
                        try {
                            const maybe = (handler as any)(req, resShim);
                            if (maybe instanceof Response) return maybe;
                        } catch (e) {
                            throw e;
                        }
                        const { status, body } = getStatusBody();
                        const bodyStream = body === null ? null : body;
                        return new Response(bodyStream, { status, headers });
                    }

                    // Prefer the modern (req, ctx) signature. If it returns undefined,
                    // fall back to a one-shot legacy shim invocation for one release
                    // cycle to ease migration. This avoids returning 500s while still
                    // providing a clear migration path.
                    let ret: any;
                    try {
                        ret = await handler(req, ctx as Context);
                    } catch (e) {
                        throw e;
                    }
                    // Normalize any non-Response return value into a Response
                    if (ret !== undefined && ret !== null) {
                        if (ret instanceof Response) return ret;
                        try {
                            return new Response(JSON.stringify(ret), { status: 200, headers: { "Content-Type": "application/json" } });
                        } catch (e) {
                            return new Response(String(ret), { status: 200 });
                        }
                    }

                    // Handler returned undefined. As a temporary migration aid,
                    // invoke the handler once with the legacy res shim and return
                    // its produced response. Do NOT re-invoke the handler elsewhere
                    // to avoid side-effect duplication.
                    logger.warn({ component: "SERVER", path: url.pathname }, "Handler returned undefined. Falling back to legacy res shim once. Mark legacy handlers with handler.__legacy = true or set OM_LEGACY_HANDLER_MODE to keep legacy behavior.");
                    const { resShim, headers, getStatusBody } = makeResShim();
                    try {
                        // Call as legacy (req, res) once
                        const maybe = (handler as any)(req, resShim);
                        // If handler returned a Response directly, use it
                        if (maybe instanceof Response) return maybe;
                    } catch (e) {
                        throw e;
                    }
                    const { status, body } = getStatusBody();
                    const bodyStream = body === null ? null : body;
                    return new Response(bodyStream, { status, headers });
                };

                try {
                    const ret = await runner(0);
                    // Handler should return a Response. If it returned something
                    // serializable, convert to JSON Response as a fallback.
                    if (ret instanceof Response) return ret;
                    try {
                        return new Response(JSON.stringify(ret ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
                    } catch (e) {
                        return new Response(String(ret), { status: 200 });
                    }
                } catch (e: any) {
                    logger.error({ component: "SERVER", err: e, path: url.pathname }, "Unhandled fetch error");
                    return new Response(JSON.stringify({ error: "Internal Server Error", message: e.message }),
                        { status: 500, headers: { "Content-Type": "application/json" } });
                }
            };

            // Bun's websocket handlers expect an object with open/message/close
            // functions. Keep the shape strict to satisfy TypeScript. Route
            // selection is performed inside each handler by inspecting
            // ws.data.url.pathname so we don't attempt to construct a dynamic
            // map of path -> handler (which does not match the expected type).
            const websocket: any = {
                open(ws: any) {
                    const route = ws_routes.find((r) => r.path === ws.data.url.pathname);
                    if (route && typeof route.handler.open === "function") route.handler.open(ws);
                },
                message(ws: any, msg: any) {
                    const route = ws_routes.find((r) => r.path === ws.data.url.pathname);
                    if (route && typeof route.handler.message === "function") route.handler.message(ws, msg);
                },
                close(ws: any, code: any, reason: any) {
                    const route = ws_routes.find((r) => r.path === ws.data.url.pathname);
                    if (route && typeof route.handler.close === "function") route.handler.close(ws, code, reason);
                },
            } as any;

            server = Bun.serve({
                port,
                fetch,
                websocket,
                development: env.mode === "development",
            });

            if (callback) callback();
        },

        matchRoute(method: string, path: string) {
            for (const route of routes) {
                if (route.method !== method.toUpperCase()) continue;

                const routeParts = route.path.split("/").filter(Boolean);
                const pathParts = path.split("/").filter(Boolean);

                if (routeParts.length !== pathParts.length) continue;

                const params: Record<string, string> = {};
                let match = true;
                for (let i = 0; i < routeParts.length; i++) {
                    if (routeParts[i].startsWith(":")) {
                        params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
                    } else if (routeParts[i] !== pathParts[i]) {
                        match = false;
                        break;
                    }
                }
                if (match) return { handler: route.handler, params };
            }
            return { handler: null, params: {} };
        },

        stop() {
            if (server) server.stop(true);
        }
    };

    return app;
}
