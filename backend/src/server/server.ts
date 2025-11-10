import {
    Server,
    ServeOptions,
    WebSocketHandler,
    WebSocketServeOptions,
} from "bun";
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

type RouteHandler = (
    req: Request,
    ctx: Context,
) => Response | Promise<Response>;

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
    let server: Server;

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
                        if (server.upgrade(req, {data: {url}})) {
                            return new Response(null, { status: 101 });
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

                // Body parsing middleware
                if (req.body && (req.headers.get("content-type") || "").includes("application/json")) {
                     if (config.max_payload_size && Number(req.headers.get("content-length")) > config.max_payload_size) {
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
                    return handler(req, ctx);
                };

                try {
                    return await runner(0);
                } catch (e: any) {
                    logger.error({ component: "SERVER", err: e, path: url.pathname }, "Unhandled fetch error");
                    return new Response(JSON.stringify({ error: "Internal Server Error", message: e.message }),
                        { status: 500, headers: { "Content-Type": "application/json" } });
                }
            };

            const websocket: WebSocketServeOptions<any>["websocket"] = {
                ...ws_routes.reduce((acc, route) => {
                    acc[route.path] = route.handler;
                    return acc;
                }, {} as Record<string, WebSocketRouteHandler>),

                open(ws) {
                    const route = ws_routes.find(r => r.path === ws.data.url.pathname);
                    if (route?.handler.open) route.handler.open(ws);
                },
                message(ws, msg) {
                    const route = ws_routes.find(r => r.path === ws.data.url.pathname);
                     if (route?.handler.message) route.handler.message(ws, msg);
                },
                close(ws, code, reason) {
                    const route = ws_routes.find(r => r.path === ws.data.url.pathname);
                    if (route?.handler.close) route.handler.close(ws, code, reason);
                },
            };

            server = Bun.serve({
                port,
                fetch,
                websocket,
                development: env.OM_MODE === 'development',
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
