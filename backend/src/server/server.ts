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

type WebSocketRouteHandler = WebSocketHandler<{ url: URL }>;

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

                // WebSocket upgrade: support dynamic routes (e.g., /ws/:room)
                if (req.headers.get("upgrade") === "websocket") {
                    const { route, params } = (app as any).matchWsRoute(url.pathname);
                    if (route) {
                        // Let Bun perform the 101 handshake implicitly when upgrade succeeds.
                        // Include the parsed params in the upgrade data so handlers
                        // that inspect ws.data immediately can access them. server.upgrade
                        // returns true on success. In that case return undefined so Bun
                        // completes the upgrade. On failure return 500 and log.
                        if ((server as any).upgrade(req, { data: { url, params } })) {
                            logger.info({ component: "SERVER", path: url.pathname, params }, `WS upgraded for ${url.pathname}`);
                            return undefined as any;
                        }
                        logger.error({ component: "SERVER", path: url.pathname }, `WS upgrade failed for path: ${url.pathname}`);
                        return new Response("WebSocket upgrade failed", { status: 500 });
                    }
                }

                const { handler, params } = (app as any).matchRoute(req.method, url.pathname);

                if (!handler) {
                    return new Response("Not Found", { status: 404 });
                }

                const ctx: Context = {
                    params,
                    query: url.searchParams,
                };

                // Backward compatibility: some legacy handlers and middleware read
                // `req.params` and `req.query`. Populate them here before calling
                // middleware so both styles work.
                try {
                    (req as any).params = params;
                    (req as any).query = url.searchParams;
                } catch (e) {
                    // ignore failures assigning shim properties
                }

                // Call handlers with (req, ctx). Handlers must return a Response.

                // Body parsing middleware: parse JSON when Content-Type indicates JSON.
                // Enforce max payload size even when Content-Length is absent by streaming
                const contentType = (req.headers.get("content-type") || "").toLowerCase();
                if (contentType.includes("application/json")) {
                    const maxSize = config.max_payload_size || (env && (env.max_payload_size as any)) || 1000000;
                    const lenHeader = req.headers.get("content-length");
                    if (lenHeader) {
                        const len = Number(lenHeader || 0);
                        if (maxSize && len > maxSize) {
                            return new Response(JSON.stringify({ error: "payload_too_large", message: "Payload Too Large" }), { status: 413, headers: { "Content-Type": "application/json" } });
                        }
                    }

                    // Read the request body as a stream and enforce maxSize
                    try {
                        const reader: any = (req as any).body?.getReader?.();
                        if (reader) {
                            const chunks: Uint8Array[] = [];
                            let received = 0;
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                if (value) {
                                    received += value.byteLength || value.length || 0;
                                    if (maxSize && received > maxSize) {
                                        return new Response(JSON.stringify({ error: "payload_too_large", message: "Payload Too Large" }), { status: 413, headers: { "Content-Type": "application/json" } });
                                    }
                                    chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
                                }
                            }
                            // Concatenate chunks
                            const total = new Uint8Array(received);
                            let offset = 0;
                            for (const c of chunks) {
                                total.set(c, offset);
                                offset += c.length;
                            }
                            const text = new TextDecoder().decode(total);
                            try {
                                ctx.body = JSON.parse(text);
                                // Preserve legacy Express-style expectation of req.body for
                                // handlers that read the body directly from the request
                                // object (OM_LEGACY_HANDLER_MODE compatibility).
                                try { (req as any).body = ctx.body; } catch (e) { /* ignore assignment failures */ }
                            } catch (e) {
                                return new Response(JSON.stringify({ error: "invalid_json", message: "Invalid JSON payload" }), { status: 400, headers: { "Content-Type": "application/json" } });
                            }
                        } else {
                            // Fallback: read text and enforce size
                            const text = await req.text();
                            // Enforce payload size in bytes to correctly account for
                            // multi-byte UTF-8 characters (avoid using text.length).
                            const byteLen = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).byteLength : Buffer.byteLength(text, 'utf8');
                            if (maxSize && byteLen > maxSize) {
                                return new Response(JSON.stringify({ error: "payload_too_large", message: "Payload Too Large" }), { status: 413, headers: { "Content-Type": "application/json" } });
                            }
                            try {
                                ctx.body = JSON.parse(text);
                                // Preserve legacy Express-style expectation of req.body
                                try { (req as any).body = ctx.body; } catch (e) { /* ignore assignment failures */ }
                            } catch (e) {
                                return new Response(JSON.stringify({ error: "invalid_json", message: "Invalid JSON payload" }), { status: 400, headers: { "Content-Type": "application/json" } });
                            }
                        }
                    } catch (e) {
                        return new Response(JSON.stringify({ error: "invalid_json", message: "Invalid JSON payload" }), { status: 400, headers: { "Content-Type": "application/json" } });
                    }
                }

                // Robust fallback: some runtimes or edge cases may leave ctx.body
                // undefined even when a JSON payload was provided. As a final
                // attempt, try to read the raw request text and parse JSON. Do
                // this only when we expect JSON to avoid interfering with other
                // content types. Wrap in try/catch to avoid throwing during
                // normal request handling.
                try {
                    if ((ctx as any).body === undefined && contentType.includes("application/json")) {
                        let rawText: string | undefined = undefined;
                        // Some runtimes place a cached raw body on the request
                        if (typeof (req as any).rawBody === 'string') rawText = (req as any).rawBody;
                        // Fall back to reading text() if available and not yet consumed
                        if (!rawText && typeof (req as any).text === 'function') {
                            try {
                                rawText = await (req as any).text();
                            } catch (e) {
                                // Could be locked/consumed; ignore and proceed
                                rawText = undefined;
                            }
                        }
                        if (rawText) {
                            try {
                                (ctx as any).body = JSON.parse(rawText);
                                try { (req as any).body = (ctx as any).body; } catch (_) { }
                            } catch (_e) {
                                // leave ctx.body undefined so validation reports invalid_json
                            }
                        }
                    }
                } catch (e) {
                    // swallow any fallback errors — don't change main behavior
                }

                const runner = async (index: number): Promise<Response> => {
                    if (index < middlewares.length) {
                        return middlewares[index](req, ctx, () => runner(index + 1));
                    }

                    // Determine whether this handler is a legacy Express-style handler.
                    // To avoid re-invoking route code, only call the handler in legacy
                    // mode if it's explicitly marked or the global migration flag is set.
                    const isExplicitLegacy = (handler as any).__legacy === true;
                    // Default to modern (req, ctx) invocation. Legacy mode is
                    // opt-in to avoid surprising modern handlers being invoked
                    // with a legacy-style response shim. To enable legacy mode
                    // set OM_LEGACY_HANDLER_MODE=true in the environment.
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

                    // Decide invocation mode up-front. If handler is explicitly
                    // marked as legacy (handler.__legacy === true) or the global
                    // legacy mode is enabled, call the handler once in legacy
                    // mode. Otherwise prefer the modern (req, ctx) signature and
                    // require a non-undefined return value. Returning `undefined`
                    // from a modern handler is considered an error and will result
                    // in a 500 response with guidance for migration.
                    const isLegacyMode = isExplicitLegacy || globalLegacyMode;

                    if (isLegacyMode) {
                        const { resShim, headers, getStatusBody } = makeResShim();
                        try {
                            const maybe = (handler as any)(req, resShim);
                            if (maybe && typeof maybe.then === "function") {
                                const awaited = await maybe;
                                if (awaited instanceof Response) return awaited;
                            } else {
                                if (maybe instanceof Response) return maybe;
                            }
                        } catch (e) {
                            throw e;
                        }
                        const { status, body } = getStatusBody();
                        const bodyStream = body === null ? null : body;
                        // Mark request to skip CORS handling for streaming/legacy body
                        try { (ctx as any).skipCors = true; } catch (e) { /* ignore */ }
                        return new Response(bodyStream, { status, headers });
                    }

                    // Modern invocation path: call the handler once with (req, ctx)
                    // and require it to return a Response (or serializable value).
                    let ret: any;
                    try {
                        ret = await handler(req, ctx as Context);
                    } catch (e) {
                        throw e;
                    }

                    // If the handler returned a Response or a serializable value,
                    // normalize and return. If it returned undefined, treat this
                    // as an error and instruct the developer how to proceed.
                    if (ret !== undefined && ret !== null) {
                        if (ret instanceof Response) {
                            try {
                                // If the returned Response contains a streaming body or
                                // is likely a stream-based payload, mark ctx.skipCors
                                // so downstream CORS middleware doesn't attempt to
                                // clone/rewrap locked body streams.
                                const body = (ret as any).body;
                                const isStream = body && typeof body.getReader === 'function';
                                const contentType = ret.headers?.get?.('content-type') || '';
                                // Do not auto-set ctx.skipCors here. Handlers that need
                                // to opt-out should set `ctx.skipCors = true` themselves.
                                // Auto-setting caused the opt-out to leak into other
                                // responses in some runtimes.
                            } catch (e) { }
                            return ret;
                        }
                        try {
                            return new Response(JSON.stringify(ret), { status: 200, headers: { "Content-Type": "application/json" } });
                        } catch (e) {
                            return new Response(String(ret), { status: 200 });
                        }
                    }

                    // Handler returned undefined in modern mode: fail fast and
                    // provide a clear migration message rather than attempting to
                    // re-invoke the handler (which can cause duplicate side-effects).
                    logger.error({ component: "SERVER", path: url.pathname }, "Handler returned undefined in modern mode. To maintain compatibility mark legacy handlers with handler.__legacy = true or set OM_LEGACY_HANDLER_MODE=true. Otherwise ensure handlers return a Response or serializable value.");
                    return new Response(JSON.stringify({ error: "handler_returned_undefined", message: "Handler returned undefined in modern (req, ctx) mode. Mark legacy handlers with handler.__legacy = true or set OM_LEGACY_HANDLER_MODE=true to opt-in to legacy (req, res) behavior, or update the handler to return a Response or a serializable value." }), { status: 500, headers: { "Content-Type": "application/json" } });
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
            // The canonical route matcher is exposed as `app.matchWsRoute` below.
            const websocket: any = {
                open(ws: any) {
                    const { route, params } = (app as any).matchWsRoute(ws.data.url.pathname);
                    if (route) {
                        // Expose matched params to the handler via ws.data.params
                        try { ws.data.params = { ...(ws.data.params || {}), ...params }; } catch (e) { /* ignore */ }
                        if (typeof route.handler.open === "function") {
                            try { route.handler.open(ws); } catch (e) { /* ignore errors from handler */ }
                        }
                    }
                },
                message(ws: any, msg: any) {
                    const { route, params } = (app as any).matchWsRoute(ws.data.url.pathname);
                    if (route) {
                        try { ws.data.params = { ...(ws.data.params || {}), ...params }; } catch (e) { /* ignore */ }
                        if (typeof route.handler.message === "function") route.handler.message(ws, msg);
                    }
                },
                close(ws: any, code: any, reason: any) {
                    const { route, params } = (app as any).matchWsRoute(ws.data.url.pathname);
                    if (route) {
                        try { ws.data.params = { ...(ws.data.params || {}), ...params }; } catch (e) { /* ignore */ }
                        if (typeof route.handler.close === "function") route.handler.close(ws, code, reason);
                    }
                },
            } as any;

            server = Bun.serve({
                port,
                fetch,
                websocket,
                development: env.mode === "development",
            });
            if (callback) callback();

            // Return the underlying server instance to callers so they can
            // inspect runtime details (bound port when using port 0, etc.).
            return server;
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

        // Match websocket routes supporting dynamic parameters similar to
        // HTTP route matching. Returns { route, params } where `route` is the
        // matched WebSocketRoute or null when no route matches.
        matchWsRoute(pathname: string) {
            for (const r of ws_routes) {
                const routeParts = r.path.split("/").filter(Boolean);
                const pathParts = pathname.split("/").filter(Boolean);
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
                if (match) return { route: r, params };
            }
            return { route: null, params: {} };
        },

        stop() {
            if (server) server.stop(true);
        }
    };

    return app;
}
