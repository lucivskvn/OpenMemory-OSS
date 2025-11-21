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
import {
    start_user_summary_reflection,
    stop_user_summary_reflection,
} from "../memory/user_summary";
import { req_tracker_mw } from "./routes/dashboard";
import { request_logger_mw } from "./middleware/request_logger";
import { showBanner } from "./banner";
import { backupDatabase, enforceBackupRetention } from "../utils/backup.js";
import * as cron from "node-cron";

const ASC_B64 =
    "ICAgX19fICAgICAgICAgICAgICAgICAgIF9fICBfXyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogIC8gXyBcIF8gX18gICBfX18gXyBfXyB8ICBcLyAgfCBfX18gXyBfXyBfX18gICBfX18gIF8gX18gXyAgIF8gCiB8IHwgfCB8ICdfIFwgLyBfIFwgJ18gXHwgfFwvfCB8LyBfIFwgJ18gYCBfIFwgLyBfIFx8ICdfX3wgfCB8IHwKIHwgfF98IHwgfF8pIHwgIF9fLyB8IHwgfCB8ICB8IHwgIF9fLyB8IHwgfCB8IHwgKF8pIHwgfCAgfCB8X3wgfAogIFxfX18vfCAuX18vIFxfX198X3wgfF98X3wgIHxffFxfX18vfF98ICAgXF9fLCB8CiAgICAgICB8X3wgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8X19fLyA=";
const ASC = Buffer.from(ASC_B64, "base64").toString("utf8");

let serverApp: ReturnType<typeof createServer> | null = null;
let decayIntervalId: any = null;
let pruneIntervalId: any = null;
let backupCronJob: cron.ScheduledTask | null = null;

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
            "Content-Type,Authorization,x-api-key,x-admin-key",
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
            const respContentType = resp?.headers?.get?.("content-type") || "";
            const respBody = (resp as any)?.body;
            const respIsStream =
                respBody && typeof respBody.getReader === "function";
            if (
                ctx &&
                (ctx as any).skipCors &&
                (respIsStream ||
                    (typeof respContentType === "string" &&
                        respContentType.includes("stream")))
            ) {
                logger.info(
                    { component: "CORS", path: (req as any).url || req.url },
                    "Handler set ctx.skipCors; returning streaming response unmodified",
                );
                return resp;
            }
        } catch (e) {}

        // If the response itself indicates a streaming content-type, don't
        // attempt to clone or rewrap it — return it unmodified. Avoid relying
        // on the request's Accept header (which can be influenced by clients
        // or reused connections) to detect streaming responses because that
        // produced false positives when tests reused connections. Use the
        // response's content-type and ctx.skipCors instead.
        try {
            if (
                resp &&
                resp.headers &&
                resp.headers.get("content-type")?.includes("stream")
            )
                return resp;
        } catch (e) {}

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
                    for (const [k, v] of (corsHeaders as any).entries())
                        mergedFallback.set(k, v as string);
                    const prevVary = mergedFallback.get("Vary");
                    if (!prevVary) {
                        mergedFallback.set("Vary", "Origin");
                    } else {
                        const parts = prevVary.split(",").map((s) => s.trim());
                        if (!parts.includes("Origin"))
                            mergedFallback.set("Vary", `${prevVary}, Origin`);
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
            for (const [k, v] of (corsHeaders as any).entries())
                merged.set(k, v as string);
            const existingVary = merged.get("Vary");
            if (!existingVary) {
                merged.set("Vary", "Origin");
            } else {
                const parts = existingVary.split(",").map((s) => s.trim());
                if (!parts.includes("Origin"))
                    merged.set("Vary", `${existingVary}, Origin`);
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

export async function startServer(options?: {
    port?: number;
    dbPath?: string;
    waitUntilReady?: boolean;
}) {
    // Allow tests or callers to override DB path or port programmatically.
    if (options?.dbPath !== undefined) {
        process.env.OM_DB_PATH = options.dbPath;
        // Update parsed env object so initDb picks up the override at runtime
        try {
            (env as any).db_path = options.dbPath;
        } catch (e) {}
    }
    const requestedPort = options?.port ?? env.port;
    // Forbid port 0 (OS-assigned ephemeral) except in test mode to prevent production accidents
    if (requestedPort === 0 && process.env.OM_TEST_MODE !== "1") {
        const error = new Error(
            "Port 0 (OS-assigned ephemeral) forbidden in production. Use OM_TEST_MODE=1 for tests or specify a fixed port.",
        );
        logger.error(
            {
                component: "SERVER",
                error_code: "port_zero_forbidden",
                port: requestedPort,
            },
            error.message,
        );
        throw error;
    }
    if (options?.port !== undefined) process.env.OM_PORT = String(options.port);

    await initDb();
    // Clear any runtime embedding overrides to avoid leakage between test runs.
    try {
        const embedMod = await import("../memory/embed");
        if (typeof embedMod.resetRuntimeConfig === "function")
            embedMod.resetRuntimeConfig();
    } catch (e) {
        /* ignore if not available */
    }

    // Ensure DB migrations are applied for the selected DB path by importing the
    // top-level migration runner which uses the DB helpers already initialized
    // above. If the migration module cannot run (missing optional deps), log
    // and continue — callers/tests that require migrations should run the
    // migrate script explicitly.
    try {
        if (process.env.OM_SKIP_MIGRATE === "true") {
            if (env.log_migrate)
                logger.info(
                    { component: "MIGRATE" },
                    "Skipping automatic in-process migrations due to OM_SKIP_MIGRATE=true",
                );
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
        logger.warn(
            {
                component: "MIGRATE",
                error_code: "migrate_application_failed",
                err: e,
            },
            "Automatic migrations could not be applied in-process; continuing",
        );
    }

    const app = createServer({ max_payload_size: env.max_payload_size });
    serverApp = app;

    // Show the ASCII header: structured log (base64) + colored terminal banner when TTY
    showBanner(ASC);
    logger.info(
        { component: "SERVER", runtime: `Bun v${Bun.version}` },
        "[SERVER] Server starting...",
    );
    logger.info(
        {
            component: "CONFIG",
            tier: tier,
            vector_dim: env.vec_dim,
            cache_segments: env.cache_segments,
            max_active_queries: env.max_active,
        },
        "[CONFIG] Configuration loaded",
    );

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
        logger.info(
            { component: "MODE", mode: "langgraph" },
            "[MODE] LangGraph integration enabled",
        );
    }

    const decayIntervalMs = env.decay_interval_minutes * 60 * 1000;
    logger.info(
        {
            component: "DECAY",
            interval_minutes: env.decay_interval_minutes,
            interval_ms: decayIntervalMs,
        },
        "[DECAY] Decay process configured",
    );

    // Allow tests to disable background work for deterministic behavior. When
    // `OM_TEST_MODE=1` is set, or when `OM_SKIP_BACKGROUND=true` is configured,
    // skip scheduling or running background jobs like decay/prune/reflection.
    const skipBackground =
        process.env.OM_SKIP_BACKGROUND === "true" ||
        process.env.OM_TEST_MODE === "1";

    if (!skipBackground) {
        decayIntervalId = setInterval(async () => {
            logger.info(
                { component: "DECAY" },
                "[DECAY] Running HSG decay process...",
            );
            try {
                const result = await run_decay_process();
                logger.info(
                    {
                        component: "DECAY",
                        decayed: result.decayed,
                        processed: result.processed,
                    },
                    "[DECAY] Decay process completed",
                );
            } catch (error) {
                logger.error(
                    { component: "DECAY", err: error },
                    "[DECAY] Decay process failed",
                );
            }
        }, decayIntervalMs);
    } else {
        logger.info(
            { component: "DECAY" },
            "Skipping background decay because OM_SKIP_BACKGROUND or OM_TEST_MODE is set",
        );
    }

    if (!skipBackground) {
        pruneIntervalId = setInterval(
            async () => {
                logger.info(
                    { component: "PRUNE" },
                    "[PRUNE] Pruning weak waypoints...",
                );
                try {
                    const pruned = await prune_weak_waypoints();
                    logger.info(
                        { component: "PRUNE", pruned_count: pruned },
                        "[PRUNE] Pruning completed",
                    );
                } catch (error) {
                    logger.error(
                        { component: "PRUNE", err: error },
                        "[PRUNE] Pruning failed",
                    );
                }
            },
            7 * 24 * 60 * 60 * 1000,
        );
    } else {
        logger.info(
            { component: "PRUNE" },
            "Skipping periodic waypoint pruning because OM_SKIP_BACKGROUND or OM_TEST_MODE is set",
        );
    }

    if (!skipBackground) {
        run_decay_process()
            .then((result: any) => {
                logger.info(
                    {
                        component: "INIT",
                        decayed: result.decayed,
                        processed: result.processed,
                    },
                    "[INIT] Initial decay process completed",
                );
            })
            .catch((err) =>
                logger.error(
                    { component: "INIT", err },
                    "[INIT] Initial decay failed",
                ),
            );
    } else {
        logger.info(
            { component: "INIT" },
            "Skipping initial decay because OM_SKIP_BACKGROUND or OM_TEST_MODE is set",
        );
    }

    if (!skipBackground && env.backup_auto_schedule) {
        logger.info(
            {
                component: "BACKUP",
                cron: env.backup_schedule_cron,
                dir: env.backup_dir,
            },
            "[BACKUP] Scheduling automatic backups",
        );
        backupCronJob = cron.schedule(
            env.backup_schedule_cron,
            async () => {
                logger.info(
                    { component: "BACKUP" },
                    "[BACKUP] Running scheduled backup...",
                );
                try {
                    const timestamp = new Date()
                        .toISOString()
                        .replace(/[:.]/g, "-");
                    const backupFilename = `backup-auto-${timestamp}.db`;
                    const destPath = `${env.backup_dir}/${backupFilename}`;

                    await backupDatabase({
                        sourcePath: env.db_path,
                        destPath,
                    });

                    // Enforce retention policy after successful backup
                    const removedCount = await enforceBackupRetention(
                        env.backup_dir,
                        env.backup_retention_days,
                    );
                    if (removedCount > 0) {
                        logger.info(
                            { component: "BACKUP", removed: removedCount },
                            "[BACKUP] Retention policy enforced",
                        );
                    }

                    logger.info(
                        { component: "BACKUP", filename: backupFilename },
                        "[BACKUP] Scheduled backup completed",
                    );
                } catch (error) {
                    logger.error(
                        { component: "BACKUP", err: error },
                        "[BACKUP] Scheduled backup failed",
                    );
                }
            },
            {
                scheduled: false, // Don't start immediately, wait for server to be ready
            },
        );

        // Start the cron job
        backupCronJob.start();
    } else {
        logger.info(
            { component: "BACKUP" },
            "Skipping automatic backup scheduling because disabled, OM_SKIP_BACKGROUND, or OM_TEST_MODE is set",
        );
    }

    if (!skipBackground) {
        start_reflection();
        start_user_summary_reflection();
    } else {
        logger.info(
            { component: "REFLECT" },
            "Skipping background reflections because OM_SKIP_BACKGROUND or OM_TEST_MODE is set",
        );
    }

    const listenPort = options?.port ?? env.port;
    logger.info(
        { component: "SERVER", port: listenPort },
        `[SERVER] Starting server...`,
    );
    const srv = app.listen(listenPort, () => {
        logger.info(
            { component: "SERVER", url: `http://localhost:${listenPort}` },
            `[SERVER] Server running`,
        );
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
    } catch (e) {}

    // Optionally wait until the server returns a healthy status to avoid
    // races in tests that make immediate HTTP requests after start.
    if (options?.waitUntilReady) {
        const timeoutMs =
            Number(process.env.OM_TEST_SERVER_READY_TIMEOUT) || 2000;
        const start = Date.now();
        let lastErr: any = null;
        while (Date.now() - start < timeoutMs) {
            try {
                // Use the original global fetch if tests have overridden it to
                // block external network requests. Tests set `globalThis.__ORIG_FETCH`
                // to the original fetch before they overwrite `fetch` to prevent
                // accidental external calls. Prefer that if available so in-test
                // health checks continue to work.
                const rawFetch: typeof fetch =
                    (globalThis as any).__ORIG_FETCH ??
                    (globalThis as any).fetch ??
                    fetch;
                const resp = await rawFetch(
                    `http://127.0.0.1:${actualPort}/health`,
                );
                if (resp && resp.status === 200) {
                    break;
                }
            } catch (e) {
                lastErr = e;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        if (Date.now() - start >= timeoutMs) {
            logger.warn(
                { component: "SERVER", err: lastErr },
                `[SERVER] Waited ${timeoutMs}ms for /health but it did not return 200; continuing`,
            );
        }
    }

    return {
        port: actualPort,
        stop: async () => {
            if (decayIntervalId) clearInterval(decayIntervalId as any);
            if (pruneIntervalId) clearInterval(pruneIntervalId as any);
            if (backupCronJob) backupCronJob.stop();
            try {
                stop_reflection();
            } catch (e) {}
            try {
                stop_user_summary_reflection();
            } catch (e) {}
            if (serverApp) serverApp.stop();
        },
    };
}

export async function stopServer() {
    if (decayIntervalId) clearInterval(decayIntervalId as any);
    if (pruneIntervalId) clearInterval(pruneIntervalId as any);
    if (backupCronJob) backupCronJob.stop();
    try {
        stop_reflection();
    } catch (e) {}
    try {
        stop_user_summary_reflection();
    } catch (e) {}
    if (serverApp) serverApp.stop();
}

// Auto-start when executed directly or imported by callers that expect side-effects.
// For tests that want programmatic control, set OM_NO_AUTO_START=true in the env
// before importing this module.
if (!process.env.OM_NO_AUTO_START) {
    startServer().catch((e) => {
        logger.error(
            { component: "SERVER", err: e },
            "[SERVER] Failed to start server: %o",
            e,
        );
        process.exit(1);
    });
}
