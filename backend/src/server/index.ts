import { createServer } from "./server";
import { env, tier } from "../core/cfg";
import { initDb } from "../core/db";
import logger from "../core/logger";
import { run_decay_process, prune_weak_waypoints } from "../memory/hsg";
import { mcp } from "../ai/mcp";
import { routes } from "./routes";
import {
    authenticate_api_request,
    log_authenticated_request,
} from "./middleware/auth";
import { start_reflection, stop_reflection } from "../memory/reflect";
import { start_user_summary_reflection, stop_user_summary_reflection } from "../memory/user_summary";
import { req_tracker_mw } from "./routes/dashboard";
import { request_logger_mw } from "./middleware/request_logger";
import { showBanner } from "./banner";

const ASC_B64 = "ICAgX19fICAgICAgICAgICAgICAgICAgIF9fICBfXyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogIC8gXyBcIF8gX18gICBfX18gXyBfXyB8ICBcLyAgfCBfX18gXyBfXyBfX18gICBfX18gIF8gX18gXyAgIF8gCiB8IHwgfCB8ICdfIFwgLyBfIFwgJ18gXHwgfFwvfCB8LyBfIFwgJ18gYCBfIFwgLyBfIFx8ICdfX3wgfCB8IHwKIHwgfF98IHwgfF8pIHwgIF9fLyB8IHwgfCB8ICB8IHwgIF9fLyB8IHwgfCB8IHwgKF8pIHwgfCAgfCB8X3wgfAogIFxfX18vfCAuX18vIFxfX198X3wgfF98X3wgIHxffFxfX198X3wgfF98IHxffFxfX18vfF98ICAgXF9fLCB8CiAgICAgICB8X3wgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8X19fLyA=";
const ASC = Buffer.from(ASC_B64, "base64").toString("utf8");

let serverApp: ReturnType<typeof createServer> | null = null;
let decayIntervalId: any = null;
let pruneIntervalId: any = null;

// Exported CORS middleware factory so tests can import and exercise it.
// See comments below for behavior and opt-out using `ctx.skipCors`.
export function corsMiddleware() {
    return async (req: Request, ctx: any, next: () => Promise<Response>) => {
        const corsHeaders = new Headers();
        corsHeaders.set("Access-Control-Allow-Origin", "*");
        corsHeaders.set(
            "Access-Control-Allow-Methods",
            "GET,POST,PUT,DELETE,OPTIONS",
        );
        corsHeaders.set(
            "Access-Control-Allow-Headers",
            "Content-Type,Authorization,x-api-key",
        );
        corsHeaders.set(
            "Access-Control-Allow-Credentials",
            process.env.OM_CORS_CREDENTIALS === "true" ? "true" : "false",
        );

        // Do not short-circuit here when ctx.skipCors is set: we need to
        // await the handler so we can inspect the actual Response. Some
        // handlers may set ctx.skipCors but still return a non-streaming
        // response; in that case we should still merge CORS headers. We'll
        // decide after the handler returns based on both ctx.skipCors and the
        // response's content-type/body.

        if (req.method === "OPTIONS") {
            return new Response(null, { status: 200, headers: corsHeaders });
        }

        const resp = await next();

        try {
            // Only skip merging when the handler explicitly opted out AND the
            // response appears to be streaming. This avoids leaking the opt-out
            // into subsequent non-streaming responses in case of accidental
            // ctx mutation.
            const respContentType = resp?.headers?.get?.('content-type') || '';
            const respBody = (resp as any)?.body;
            const respIsStream = respBody && typeof respBody.getReader === 'function';
            if (ctx && (ctx as any).skipCors && (respIsStream || (typeof respContentType === 'string' && respContentType.includes('stream')))) {
                logger.info({ component: "CORS", path: (req as any).url || req.url }, "Handler set ctx.skipCors; returning streaming response unmodified");
                return resp;
            }
        } catch (e) { }

        // If the response itself indicates a streaming content-type, don't
        // attempt to clone or rewrap it — return it unmodified. Avoid relying
        // on the request's Accept header (which can be influenced by clients
        // or reused connections) to detect streaming responses because that
        // produced false positives when tests reused connections. Use the
        // response's content-type and ctx.skipCors instead.
        try {
            if (resp && resp.headers && resp.headers.get("content-type")?.includes("stream")) return resp;
        } catch (e) { }

        try {
            let bodyToUse: any = null;
            try {
                if (resp && typeof (resp as any).clone === "function") {
                    const cloned = (resp as any).clone();
                    bodyToUse = cloned.body;
                } else {
                    bodyToUse = resp.body;
                }
            } catch (innerErr) {
                try {
                    const mergedFallback = new Headers(resp.headers);
                    for (const [k, v] of (corsHeaders as any).entries()) mergedFallback.set(k, v as string);
                    const prevVary = mergedFallback.get("Vary");
                    if (!prevVary) {
                        mergedFallback.set("Vary", "Origin");
                    } else {
                        const parts = prevVary.split(",").map((s) => s.trim());
                        if (!parts.includes("Origin")) mergedFallback.set("Vary", `${prevVary}, Origin`);
                    }
                    return new Response(resp.body, {
                        status: resp.status,
                        statusText: (resp as any).statusText,
                        headers: mergedFallback,
                    });
                } catch (fallbackErr) {
                    return resp;
                }
            }

            const merged = new Headers(resp.headers);
            for (const [k, v] of (corsHeaders as any).entries()) merged.set(k, v as string);
            const existingVary = merged.get("Vary");
            if (!existingVary) {
                merged.set("Vary", "Origin");
            } else {
                const parts = existingVary.split(",").map((s) => s.trim());
                if (!parts.includes("Origin")) merged.set("Vary", `${existingVary}, Origin`);
            }
            return new Response(bodyToUse, {
                status: resp.status,
                statusText: (resp as any).statusText,
                headers: merged,
            });
        } catch (e) {
            return resp;
        }
    };
}

export async function startServer(options?: { port?: number; dbPath?: string }) {
    // Allow tests or callers to override DB path or port programmatically.
    if (options?.dbPath !== undefined) {
        process.env.OM_DB_PATH = options.dbPath;
        // Update parsed env object so initDb picks up the override at runtime
        try {
            (env as any).db_path = options.dbPath;
        } catch (e) { }
    }
    if (options?.port !== undefined) process.env.OM_PORT = String(options.port);

    await initDb();

    // Ensure DB migrations are applied for the selected DB path by importing the
    // top-level migration runner which uses the DB helpers already initialized
    // above. If the migration module cannot run (missing optional deps), log
    // and continue — callers/tests that require migrations should run the
    // migrate script explicitly.
    try {
        if (process.env.OM_SKIP_MIGRATE === "true") {
            logger.info({ component: "MIGRATE" }, "Skipping automatic in-process migrations due to OM_SKIP_MIGRATE=true");
        } else {
            // Import the migration module and, if it exposes `run_migrations`, call
            // and await it to ensure migrations finish before the server starts.
            // If your build bundles files, include `backend/src/migrate.ts` in the bundle
            // or set OM_SKIP_MIGRATE=true and run migrations separately in your deployment.
            const migrateMod: any = await import("../migrate");
            if (migrateMod && typeof migrateMod.run_migrations === "function") {
                await migrateMod.run_migrations();
            }
        }
    } catch (e) {
        logger.warn({ component: "MIGRATE", err: e }, "Automatic migrations could not be applied in-process; continuing");
    }

    const app = createServer({ max_payload_size: env.max_payload_size });
    serverApp = app;

    // Show the ASCII header: structured log (base64) + colored terminal banner when TTY
    showBanner(ASC);
    logger.info({ component: "SERVER", runtime: `Bun v${Bun.version}` }, "Server starting...");
    logger.info({ component: "CONFIG", tier: tier, vector_dim: env.vec_dim, cache_segments: env.cache_segments, max_active_queries: env.max_active }, "Configuration loaded");

    app.use(request_logger_mw());
    app.use(req_tracker_mw());

    // Register middleware instance (uses exported corsMiddleware above)
    app.use(corsMiddleware());

    app.use(authenticate_api_request);

    if (process.env.OM_LOG_AUTH === "true") {
        app.use(log_authenticated_request);
    }

    routes(app);

    mcp(app);
    if (env.mode === "langgraph") {
        logger.info({ component: "MODE", mode: "langgraph" }, "LangGraph integration enabled");
    }

    const decayIntervalMs = env.decay_interval_minutes * 60 * 1000;
    logger.info({ component: "DECAY", interval_minutes: env.decay_interval_minutes, interval_ms: decayIntervalMs }, "Decay process configured");

    decayIntervalId = setInterval(async () => {
        logger.info({ component: "DECAY" }, "Running HSG decay process...");
        try {
            const result = await run_decay_process();
            logger.info({ component: "DECAY", decayed: result.decayed, processed: result.processed }, "Decay process completed");
        } catch (error) {
            logger.error({ component: "DECAY", err: error }, "Decay process failed");
        }
    }, decayIntervalMs);

    pruneIntervalId = setInterval(
        async () => {
            logger.info({ component: "PRUNE" }, "Pruning weak waypoints...");
            try {
                const pruned = await prune_weak_waypoints();
                logger.info({ component: "PRUNE", pruned_count: pruned }, "Pruning completed");
            } catch (error) {
                logger.error({ component: "PRUNE", err: error }, "Pruning failed");
            }
        },
        7 * 24 * 60 * 60 * 1000,
    );

    run_decay_process()
        .then((result: any) => {
            logger.info({ component: "INIT", decayed: result.decayed, processed: result.processed }, "Initial decay process completed");
        })
        .catch((err) => logger.error({ component: "INIT", err }, "Initial decay failed"));

    start_reflection();
    start_user_summary_reflection();

    const listenPort = options?.port ?? env.port;
    logger.info({ component: "SERVER", port: listenPort }, `Starting server...`);
    const srv = app.listen(listenPort, () => {
        logger.info({ component: "SERVER", url: `http://localhost:${listenPort}` }, "Server running");
    });

    // Determine the actual bound port when the caller requested port 0.
    const actualPort = (srv as any)?.port || listenPort;

    // Expose the actual bound port via env so tests and external tools can
    // reliably discover the server port after auto-start. Some tests import
    // this module and expect `process.env.OM_PORT` to reflect the runtime
    // port; set it here so callers that read it after importing will see the
    // right value.
    try {
        process.env.OM_PORT = String(actualPort);
    } catch (e) { }

    return {
        port: actualPort,
        stop: async () => {
            if (decayIntervalId) clearInterval(decayIntervalId as any);
            if (pruneIntervalId) clearInterval(pruneIntervalId as any);
            try {
                stop_reflection();
            } catch (e) { }
            try {
                stop_user_summary_reflection();
            } catch (e) { }
            if (serverApp) serverApp.stop();
        },
    };
}

export async function stopServer() {
    if (decayIntervalId) clearInterval(decayIntervalId as any);
    if (pruneIntervalId) clearInterval(pruneIntervalId as any);
    try {
        stop_reflection();
    } catch (e) { }
    try {
        stop_user_summary_reflection();
    } catch (e) { }
    if (serverApp) serverApp.stop();
}

// Auto-start when executed directly or imported by callers that expect side-effects.
// For tests that want programmatic control, set OM_NO_AUTO_START=true in the env
// before importing this module.
if (!process.env.OM_NO_AUTO_START) {
    startServer().catch((e) => {
        logger.error({ component: "SERVER", err: e }, "[SERVER] Failed to start server: %o", e);
        process.exit(1);
    });
}
