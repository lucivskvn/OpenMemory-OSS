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
import { showBanner } from "./banner";

const ASC_B64 = "ICAgX19fICAgICAgICAgICAgICAgICAgIF9fICBfXyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogIC8gXyBcIF8gX18gICBfX18gXyBfXyB8ICBcLyAgfCBfX18gXyBfXyBfX18gICBfX18gIF8gX18gXyAgIF8gCiB8IHwgfCB8ICdfIFwgLyBfIFwgJ18gXHwgfFwvfCB8LyBfIFwgJ18gYCBfIFwgLyBfIFx8ICdfX3wgfCB8IHwKIHwgfF98IHwgfF8pIHwgIF9fLyB8IHwgfCB8ICB8IHwgIF9fLyB8IHwgfCB8IHwgKF8pIHwgfCAgfCB8X3wgfAogIFxfX18vfCAuX18vIFxfX198X3wgfF98X3wgIHxffFxfX198X3wgfF98IHxffFxfX18vfF98ICAgXF9fLCB8CiAgICAgICB8X3wgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8X19fLyA=";
const ASC = Buffer.from(ASC_B64, "base64").toString("utf8");

let serverApp: ReturnType<typeof createServer> | null = null;
let decayIntervalId: any = null;
let pruneIntervalId: any = null;

export async function startServer(options?: { port?: number; dbPath?: string }) {
    // Allow tests or callers to override DB path or port programmatically.
    if (options?.dbPath) {
        process.env.OM_DB_PATH = options.dbPath;
        // Update parsed env object so initDb picks up the override at runtime
        try {
            (env as any).db_path = options.dbPath;
        } catch (e) { }
    }
    if (options?.port) process.env.OM_PORT = String(options.port);

    initDb();

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

    app.use(req_tracker_mw());

    // Bun-compatible CORS middleware: uses (req, ctx, next) signature and augments responses.
    app.use(async (req: Request, ctx: any, next: () => Promise<Response>) => {
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
        corsHeaders.set("Access-Control-Allow-Credentials", "false");

        // Preflight
        if (req.method === "OPTIONS") {
            return new Response(null, { status: 200, headers: corsHeaders });
        }

        const resp = await next();

        // Responses returned by handlers or other middleware may be immutable
        // (frozen) in Bun's runtime. To avoid TypeError on .headers.set(),
        // create a fresh Headers object, copy existing headers, append CORS
        // headers, and return a new Response preserving body/status.
        try {
            const merged = new Headers(resp.headers);
            for (const [k, v] of corsHeaders.entries()) merged.set(k, v as string);
            return new Response(resp.body, {
                status: resp.status,
                statusText: (resp as any).statusText,
                headers: merged,
            });
        } catch (e) {
            // If anything goes wrong, return the original response as a safe fallback
            return resp;
        }
    });

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

    const listenPort = options?.port || env.port;
    logger.info({ component: "SERVER", port: listenPort }, `Starting server...`);
    app.listen(listenPort, () => {
        logger.info({ component: "SERVER", url: `http://localhost:${listenPort}` }, "Server running");
    });

    return {
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
        console.error("Failed to start server:", e);
        process.exit(1);
    });
}
