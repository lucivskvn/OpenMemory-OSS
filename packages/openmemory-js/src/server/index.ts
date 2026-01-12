import { mcp } from "../ai/mcp";
import { env, tier } from "../core/cfg";
import { closeDb } from "../core/db";
import { closeRedis } from "../core/redis";
import {
    registerInterval,
    stopAllMaintenance as stopAllSchedulerMaintenance,
} from "../core/scheduler";
import { pruneWeakWaypoints, runDecayProcess } from "../memory/hsg";
import { startReflection } from "../memory/reflect";
import { startUserSummaryReflection } from "../memory/user_summary";
import { maintenanceRetrainAll, safeJob } from "../ops/maintenance";
import { configureLogger, logger } from "../utils/logger";
import { auditMiddleware } from "./middleware/audit";
import {
    authenticateApiRequest,
    logAuthenticatedRequest,
} from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rateLimit";
import { adminRoutes } from "./routes/admin"; // Phase 35
import { compressRoutes } from "./routes/compression";
import { dash } from "./routes/dashboard";
import { reqTrackerMw } from "./routes/dashboard";
import { dynamicsRoutes } from "./routes/dynamics";
import { homeRoutes } from "./routes/home";
import { ideRoutes } from "./routes/ide";
import { langGraphRoutes } from "./routes/langgraph";
import { memoryRoutes } from "./routes/memory";
import { portabilityRoutes } from "./routes/portability";
import { sourceRoutes } from "./routes/sources";
import { setupStream } from "./routes/stream";
import { systemRoutes } from "./routes/system";
import { temporalRoutes } from "./routes/temporal";
import { userRoutes } from "./routes/users";
import { vercelRoutes } from "./routes/vercel";
import server from "./server";

export * from "./server";
// Explicitly import for local usage
import { printBanner } from "../utils/banner";
import { AdvancedRequest, AdvancedResponse } from "./server";

configureLogger({
    mode: env.mode,
    verbose: env.verbose,
    logLevel: env.logLevel,
});
logger.debug("[DEBUG] Loading src/server/index.ts (Refreshed)");

const app = server({ maxPayloadSize: env.maxPayloadSize });

printBanner();
if (env.verbose) {
    logger.info(`[CONFIG] Vector Dimension: ${env.vecDim}`);
    logger.info(`[CONFIG] Cache Segments: ${env.cacheSegments}`);
    logger.info(`[CONFIG] Max Active Queries: ${env.maxActive}`);
}

// Warn about configuration mismatch that causes embedding incompatibility
if (env.embKind !== "synthetic" && (tier === "hybrid" || tier === "fast")) {
    logger.warn(
        `[CONFIG] ⚠️  WARNING: Embedding configuration mismatch detected!\n` +
        `         OM_EMBEDDINGS=${env.embKind} but OM_TIER=${tier}\n` +
        `         Storage will use ${env.embKind} embeddings, but queries will use synthetic embeddings.\n` +
        `         This causes semantic search to fail. Set OM_TIER=deep to fix.`,
    );
}

// Security Hardening: Ensure API Key is set
// Security Hardening: Handled by Setup Token & DB Auth
// Legacy check removed to favor Multi-Tenant DB check.

app.use(reqTrackerMw());

app.use(
    async (req: AdvancedRequest, res: AdvancedResponse, next: () => void) => {
        // CORS
        const origin = req.headers.origin || req.headers.Origin || ""; // Bun headers can be case-sensitive depending on gateway

        let allowOrigin = "";
        const allowed = env.ideAllowedOrigins;

        if (allowed.includes("*") || allowed.length === 0) {
            allowOrigin = "*";
        } else if (origin && allowed.includes(origin as string)) {
            allowOrigin = origin as string;
        } else if (origin) {
            // Origin provided but not allowed.
            // We do strictly nothing, which blocks CORS.
        }

        if (allowOrigin) {
            res.setHeader("Access-Control-Allow-Origin", allowOrigin);
            res.setHeader("Vary", "Origin"); // Important for caching proxies
        }

        // Security Headers
        res.setHeader("X-DNS-Prefetch-Control", "off");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        res.setHeader(
            "Strict-Transport-Security",
            "max-age=15552000; includeSubDomains",
        );
        res.setHeader("X-Download-Options", "noopen");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-XSS-Protection", "1; mode=block");
        res.setHeader("Referrer-Policy", "no-referrer");

        if (req.method === "OPTIONS") {
            res.setHeader(
                "Access-Control-Allow-Methods",
                "GET,POST,PUT,PATCH,DELETE,OPTIONS",
            );
            res.setHeader(
                "Access-Control-Allow-Headers",
                "Content-Type,Authorization,x-api-key,Accept,x-requested-with",
            );
            res.setHeader("Access-Control-Max-Age", "86400"); // Cache preflight for 24h
            res.status(200).end();
            return;
        }
        await next();
    },
);

app.use(authenticateApiRequest);

// Register Rate Limit middleware (after Auth to potentially skip trusted users/admins if we wanted, 
// but usually before for protection. However, since we use IP-based, it's independent of auth mostly. 
// Placing it here allows us to potentially use user context later if we enhance it.)
app.use(rateLimitMiddleware);

// Register Audit middleware after Auth but before handlers
app.use(auditMiddleware);

if (env.logAuth) {
    app.use(logAuthenticatedRequest);
}
import { setupRoutes } from "./routes/setup";

// ... [omitted imports]

if (env.logAuth) {
    app.use(logAuthenticatedRequest);
}
systemRoutes(app);
setupRoutes(app); // New Setup Routes
homeRoutes(app); // Root / Welcome Page
portabilityRoutes(app);
adminRoutes(app);
userRoutes(app);
memoryRoutes(app);
temporalRoutes(app);
sourceRoutes(app);
dash(app);
vercelRoutes(app);
setupStream(app);
mcp(app);
langGraphRoutes(app);
ideRoutes(app);
dynamicsRoutes(app);
compressRoutes(app);

// Static Files - Dashboard Support (Phase 94)
import path from "path";
// We need to serve src/server/public/ as /public
// Note: app.serverStatic is a method on the underlying Bun server/handler if we were using raw Bun,
// but our 'app' is the Hono-like or custom router from ./server.ts.
// checking server.ts, it returns { ...methods, serverStatic }.
// And app.use takes a handler.
// app.serverStatic(endpoint, dir) returns a Handler.
app.use(app.serverStatic("/public", path.join(__dirname, "public")));

startReflection();
startUserSummaryReflection();

if (env.mode === "langgraph") {
    logger.info("[MODE] LangGraph integration enabled");
}

const decayIntervalMs = env.decayIntervalMinutes * 60 * 1000;
logger.info(
    `[DECAY] Interval: ${env.decayIntervalMinutes} minutes (${decayIntervalMs / 1000}s)`,
);

registerInterval(
    "decay",
    async () => {
        await safeJob("decay", async () => {
            if (env.verbose)
                logger.debug("[DECAY] Running HSG decay process...");
            const result = await runDecayProcess();
            if (env.verbose) {
                logger.debug(
                    `[DECAY] Completed: ${result.decayed}/${result.processed} memories updated`,
                );
            }
        });
    },
    decayIntervalMs,
);

// Encapsulated background process starter
export function startBackgroundProcess() {
    registerInterval(
        "prune",
        async () => {
            await safeJob("prune", async () => {
                if (env.verbose)
                    logger.debug("[PRUNE] Pruning weak waypoints...");
                const pruned = await pruneWeakWaypoints();
                if (env.verbose)
                    logger.debug(
                        `[PRUNE] Completed: ${pruned} waypoints removed`,
                    );
            });
        },
        7 * 24 * 60 * 60 * 1000,
    );

    // Delay initial background tasks to allow server startup and DB readiness
    setTimeout(() => {
        runDecayProcess()
            .then((result: { decayed: number; processed: number }) => {
                if (env.verbose) {
                    logger.debug(
                        `[INIT] Initial decay: ${result.decayed}/${result.processed} memories updated`,
                    );
                }
            })
            .catch((err: unknown) =>
                logger.error("[INIT] Initial decay failed", { error: err }),
            );
        maintenanceRetrainAll()
            .then(() => {
                if (env.verbose)
                    logger.debug(
                        "[INIT] Initial classifier training completed",
                    );
            })
            .catch((err: unknown) =>
                logger.error("[INIT] Initial training failed", { error: err }),
            );
    }, 3000);

    const trainIntervalMs = env.classifierTrainInterval * 60 * 1000;
    logger.info(
        `[TRAIN] Classifier interval: ${env.classifierTrainInterval} minutes`,
    );

    registerInterval(
        "train",
        async () => {
            await safeJob("train", async () => {
                if (env.verbose)
                    logger.debug("[TRAIN] Running auto-training process...");
                await maintenanceRetrainAll();
            });
        },
        trainIntervalMs,
    );

    // Orphaned Vector Cleanup (Daily)
    import("../ops/cleanup")
        .then(({ pruneOrphanedVectors }) => {
            registerInterval(
                "prune_vectors",
                async () => {
                    await safeJob("prune_vectors", async () => {
                        if (env.verbose)
                            logger.debug(
                                "[PRUNE] Checking for orphaned vectors...",
                            );
                        await pruneOrphanedVectors();
                    });
                },
                24 * 60 * 60 * 1000,
            ); // 24 hours
        })
        .catch((e) =>
            logger.error("[INIT] Failed to load cleanup module", { error: e }),
        );

    // Telemetry (Daily)
    import("../core/telemetry")
        .then(({ sendTelemetry }) => {
            // Send initial ping after 1 min to allow startup stabilization
            setTimeout(() => sendTelemetry().catch(() => { }), 60000);

            registerInterval(
                "telemetry",
                async () => {
                    await sendTelemetry();
                },
                24 * 60 * 60 * 1000,
            );
        })
        .catch(() => { });
}

// Export app for external usage (e.g. testing or start script)
export { app };

export async function stopServer() {
    await stopAllSchedulerMaintenance();

    // Close connections in parallel for speed, but wait for all
    await Promise.all([
        closeDb().catch((e) => logger.error("[SERVER] Failed to close DB:", { error: e })),
        closeRedis().catch((e) => logger.error("[SERVER] Failed to close Redis:", { error: e })),
    ]);
}
