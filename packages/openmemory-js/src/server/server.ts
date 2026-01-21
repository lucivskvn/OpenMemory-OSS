import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import * as path from "node:path";
import { env } from "../core/cfg";
import { q } from "../core/db";
import { UserContext } from "../core/types";
import { rid } from "../utils";
import { extractClientIp } from "../utils/ip";
import { logger } from "../utils/logger";

export interface Route {
    method: string;
    path: string;
    handlers: any[];
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
/**
 * Server configuration options.
 */
export interface ServerConfig {
    maxPayloadSize?: number;
    cors?: boolean | string[];
    logging?: boolean;
}

// Exporting types for legacy compatibility during migration if needed, 
// though we aim to move to Elysia.Context
export type ServerApp = Elysia;

/**
 * Optimized lightweight server built on ElysiaJS (Bun Native).
 * Replaces the previous custom implementation for better performance and standard tooling.
 * 
 * @param config Server configuration options
 */
export default function server(config: ServerConfig = {}) {
    const app = new Elysia({
        name: "openmemory-server",
        aot: false, // consistency in dynamic envs
    });

    // 1. Global Error Handling
    app.onError(({ code, error, set }) => {
        // Redact or simplify internal errors if needed
        let status = 500;
        let responseCode: string | number = code;

        const err = error as any;

        // Validation Errors (Elysia Validation or Zod)
        if (code === 'VALIDATION' || err.name === 'ZodError') {
            status = 400;
            responseCode = 'VALIDATION_ERROR';
        } else if (code === 'NOT_FOUND') {
            status = 404;
        } else if (code === 'PARSE') {
            status = 400; // JSON Parse error
        }

        // Map known app errors if possible, simplified for now
        if (err.statusCode) status = err.statusCode;

        // If generic error but code is undefined, use name
        if (!responseCode) responseCode = err.name || 'INTERNAL_ERROR';

        logger.error(`[SERVER] Error: ${responseCode} (${status})`, { message: err.message });

        set.status = status;
        return {
            success: false,
            error: {
                code: responseCode,
                message: err.message,
                details: err.details || err.issues || undefined
            }
        };
    });

    // 2. Middleware: Request ID & Logger
    app.onRequest(async (ctx) => {
        // Attach Request ID
        const requestId = rid();
        ctx.store = { ...ctx.store, requestId };

        if (config.logging !== false) {
            const ip = app.server?.requestIP(ctx.request);
            // We can't easily get response status *before* it happens, 
            // but we log the incoming request
            logger.info(`[HTTP] ${ctx.request.method} ${ctx.request.url} from ${ip?.address}`);
        }
    });

    // 3. CORS
    if (config.cors) {
        const origin = Array.isArray(config.cors) ? config.cors : true; // true = reflect origin
        app.use(cors({
            origin: origin,
            methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
            allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-User-ID", "X-Sector", "Range"],
            credentials: true,
        }));
    }

    // 4. Static Files (if needed helper)
    // Elysia's static plugin handles specific folders. 
    // The previous implementation had a custom `serverStatic` method.
    // We can expose a helper or register it directly.
    // For now, we expose the app instance which allows .use(staticPlugin(...))

    return app;
}

// Helper to replicate the old `serverStatic` if it was used dynamically
export const serveStaticDir = (endpoint: string, dir: string) => {
    return staticPlugin({
        assets: dir,
        prefix: endpoint
    });
};


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
