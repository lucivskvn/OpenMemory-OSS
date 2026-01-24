/**
 * Test-friendly server that doesn't start background tasks
 */
import { env } from "../src/core/cfg";
import { configureLogger, logger } from "../src/utils/logger";

// Set test mode before importing server components
Bun.env.NODE_ENV = "test";
Bun.env.OM_TEST_MODE = "true";

configureLogger({
    mode: env.mode,
    verbose: false,
    logLevel: "error",
});

// Import server factory and create app
import server from "../src/server/server";

// Create app instance
const app = server({
    cors: true,
    logging: false,
    maxPayloadSize: 1024 * 1024 * 10 // 10MB
});

// Add basic health route for testing
app.get("/health", () => ({
    success: true,
    timestamp: Date.now(),
    status: "ok"
}));

app.get("/dashboard/health", () => ({
    success: true,
    memory: {
        used: process.memoryUsage().heapUsed,
        total: process.memoryUsage().heapTotal
    },
    timestamp: Date.now()
}));

export { app };