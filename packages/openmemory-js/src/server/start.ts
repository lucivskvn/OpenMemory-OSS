/**
 * @file Server Entry Checkpoint
 * Initializes the application, runs migrations, handles telemetry,
 * and manages the graceful shutdown lifecycle.
 */
import { runAutoDiscovery } from "../ai/discovery";
import { env } from "../core/cfg";
import { q } from "../core/db";
import { runMigrations } from "../core/migrate";
import { sendTelemetry } from "../core/telemetry";
import { configureLogger, logger } from "../utils/logger";
import { app, startBackgroundProcess, stopServer } from "./index";
import { setupTokenManager } from "./setupToken";
import { WebhookService } from "../core/services/webhooks";

const SHUTDOWN_TIMEOUT = 5000;

// Start Webhook Dispatcher
WebhookService.start();

// Initialize logger with configuration
configureLogger({
    mode: env.mode,
    verbose: env.verbose,
    logLevel: env.logLevel,
});

logger.info(`[SERVER] Starting on port ${env.port}`);

// Run migrations before starting server to ensure schema is ready
try {
    await runMigrations();
    // Preload models using Bun Native Async I/O
    const { loadModelsAsync } = await import("../core/models");
    await loadModelsAsync();
} catch (e) {
    logger.error("[MIGRATE] Failed to run migrations:", { error: e });
    process.exit(1);
}

// CRITICAL SECURITY: Fail to start in production if no keys are configured
if (env.isProd && !env.apiKey && !env.adminKey) {
    logger.error("🚨 [FATAL] No API keys configured in PRODUCTION mode.");
    logger.error("   You MUST set OM_API_KEY or OM_ADMIN_KEY to secure the server.");
    process.exit(1);
}

const serverInstance = app.listen(env.port);

logger.info(`[SERVER] Running on http://localhost:${serverInstance.port}`);

// Setup Check
void (async () => {
    try {
        // Ensure database is ready before accessing q object
        const { waitForDb } = await import("../core/db/population");
        await waitForDb();

        const count = await q.getAdminCount.get();
        if ((count?.count || 0) === 0) {
            const token = setupTokenManager.generate();
            const msg = [
                "",
                "╔════════════════════════════════════════════════════════════════════╝",
                "║               OPENMEMORY SETUP REQUIRED                            ║",
                "╠════════════════════════════════════════════════════════════════════╣",
                "║  No Admin users found.                                             ║",
                "║  Use the following token to create the first admin account:        ║",
                "║                                                                    ║",
                `║  ${token.padEnd(66)}║`,
                "║                                                                    ║",
                "║  Go to Dashboard -> Setup or use POST /setup/verify                ║",
                "╚════════════════════════════════════════════════════════════════════╝",
                ""
            ].join("\n");

            // Log structurally for telemetry/files
            logger.warn("[SETUP] No Admin users found. Generated setup token.", { token });

            // Use console.log strictly for this banner to ensure visibility in standard out
            // regardless of logger configuration (which might be JSON in prod)
            // eslint-disable-next-line no-console
            console.log(msg);
        }
    } catch (e) {
        logger.error("[SETUP] Failed to check admin count", { error: e });
    }

    // Fire & Forget Auto Discovery
    runAutoDiscovery().catch((e) =>
        logger.warn("[DISCOVERY] Background check failed", { error: e }),
    );
})();

sendTelemetry().catch(() => { });
startBackgroundProcess();

const shutdown = async (signal: string) => {
    logger.info(`\n[SHUTDOWN] Received ${signal}. Graceful stop...`);

    // Force exit if cleanup takes too long
    const forceExitTimeout = setTimeout(() => {
        logger.error("[SHUTDOWN] Timeout forced exit.");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT);

    try {
        if (serverInstance) {
            await serverInstance.stop();
            logger.info("[SERVER] HTTP server stopped.");
        }

        await stopServer(); // Stops scheduler, DB, and Redis
        logger.info("[SERVER] Resources released.");

        clearTimeout(forceExitTimeout);
        process.exit(0);
    } catch (err) {
        logger.error("[SHUTDOWN] Error during graceful stop:", { error: err });
        process.exit(1);
    }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
