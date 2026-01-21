import * as path from "node:path";
import { mcpRoutes } from "../ai/mcp";
import { env, tier } from "../core/cfg";
import { closeDb } from "../core/db";
import { closeRedis } from "../core/redis";
import {
    registerInterval,
    stopAllMaintenance as stopAllSchedulerMaintenance,
} from "../core/scheduler";
import { startReflection } from "../memory/reflect";
import { startUserSummaryReflection } from "../memory/user_summary";
import { runMaintenanceRoutine, safeJob } from "../ops/maintenance";
import { configureLogger, logger } from "../utils/logger";
import { printBanner } from "../utils/banner";

// Middlewares (Plugins)
import { auditPlugin } from "./middleware/audit";
import { authPlugin } from "./middleware/auth";
import { rateLimitPlugin } from "./middleware/rateLimit";


import { adminRoutes } from "./routes/admin";
import { compressRoutes } from "./routes/compression";
import { dashboardRoutes } from "./routes/dashboard";
import { dynamicsRoutes } from "./routes/dynamics";
import { homeRoutes } from "./routes/home";
import { ideRoutes } from "./routes/ide";
import { langGraphRoutes } from "./routes/langgraph";
import { memoryRoutes } from "./routes/memory";
import { sourceRoutes } from "./routes/sources";
import { streamPlugin } from "./routes/stream";
import { systemRoutes } from "./routes/system";
import { temporalRoutes } from "./routes/temporal";
import { userRoutes } from "./routes/users";
import { vercelRoutes } from "./routes/vercel";
import { webhookRoutes } from "./routes/webhooks";
import { setupRoutes } from "./routes/setup";
import { securityRoutes } from "./routes/security";

import server from "./server";

export * from "./server";

configureLogger({
    mode: env.mode,
    verbose: env.verbose,
    logLevel: env.logLevel,
});

if (logger && typeof logger.debug === "function") {
    logger.debug("[DEBUG] Loading src/server/index.ts (Elysia Refactor)");
}

// Initialize Elysia App
const app = server({
    maxPayloadSize: env.maxPayloadSize,
    cors: env.ideMode ? env.ideAllowedOrigins : true,
    logging: true,
});

// 1. Register Core Middleware Plugins
app.use(authPlugin);      // Authentication & Context
app.use(rateLimitPlugin()); // Rate Limiting
app.use(auditPlugin);     // Auditing

// 2. Register Routes (Plugins)
app.use(systemRoutes);
app.use(temporalRoutes);
app.use(memoryRoutes);
app.use(adminRoutes);
app.use(dashboardRoutes);
app.use(sourceRoutes);
app.use(userRoutes);
app.use(securityRoutes);
app.use(webhookRoutes);
app.use(setupRoutes);
app.use(homeRoutes);
app.use(vercelRoutes);

app.use(compressRoutes);
app.use(dynamicsRoutes);
app.use(ideRoutes);
app.use(langGraphRoutes);
app.use(streamPlugin);
app.use(mcpRoutes);

printBanner();
if (env.verbose) {
    logger.info(`[CONFIG] Vector Dimension: ${env.vecDim}`);
    logger.info(`[CONFIG] Cache Segments: ${env.cacheSegments}`);
    logger.info(`[CONFIG] Max Active Queries: ${env.maxActive}`);
}

// Config Warnings
if (env.embKind !== "synthetic" && (tier === "hybrid" || tier === "fast")) {
    logger.warn(
        `[CONFIG] ⚠️  WARNING: Embedding configuration mismatch detected!\n` +
        `         OM_EMBEDDINGS=${env.embKind} but OM_TIER=${tier}\n` +
        `         Storage will use ${env.embKind} embeddings, but queries will use synthetic embeddings.`
    );
}

startReflection();
startUserSummaryReflection();

if (env.mode === "langgraph") {
    logger.info("[MODE] LangGraph integration enabled");
}

const decayIntervalMs = env.decayIntervalMinutes * 60 * 1000;
logger.info(`[DECAY] Interval: ${env.decayIntervalMinutes} minutes (${decayIntervalMs / 1000}s)`);

registerInterval(
    "maintenance",
    async () => {
        await safeJob("maintenance-routine", async () => {
            if (env.verbose)
                logger.debug("[MAINTENANCE] Running consolidated maintenance routine...");
            await runMaintenanceRoutine();
        });
    },
    decayIntervalMs,
);

// Encapsulated background process starter
export function startBackgroundProcess() {
    setTimeout(() => {
        runMaintenanceRoutine()
            .then(() => {
                if (env.verbose)
                    logger.debug(
                        "[INIT] Initial maintenance routine completed",
                    );
            })
            .catch((err: unknown) =>
                logger.error("[INIT] Initial maintenance failed", { error: err }),
            );
    }, 5000);

    // Telemetry
    import("../core/telemetry")
        .then(({ sendTelemetry }) => {
            setTimeout(() => sendTelemetry().catch(() => { }), 60000);
            registerInterval("telemetry", async () => { await sendTelemetry(); }, 86400000);
        })
        .catch(() => { });
}

// Export app
export { app };

export async function stopServer() {
    await stopAllSchedulerMaintenance();
    const { cleanupVectorStores, getContextId } = await import("../core/db");
    await Promise.all([
        closeDb().catch((e) => logger.error("[SERVER] Failed to close DB:", { error: e })),
        closeRedis().catch((e) => logger.error("[SERVER] Failed to close Redis:", { error: e })),
        cleanupVectorStores(getContextId()).catch((e) => logger.error("[SERVER] Failed to cleanup Vector Stores:", { error: e })),
    ]);
}
