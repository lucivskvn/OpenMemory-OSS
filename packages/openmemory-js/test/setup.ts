import { beforeEach, afterAll, mock } from "bun:test";
import { closeDb, waitForDb } from "../src/core/db";
import { reloadConfig } from "../src/core/cfg";
import { preTestCleanup, postTestCleanup, setupCleanupOnExit } from "../src/utils/testCleanup";
import { testProcessManager } from "../src/utils/testProcessManager";
import { initializeTestWatchdog, stopTestWatchdog } from "../src/utils/testWatchdog";

// Set consistent test environment BEFORE any imports that read env
// This prevents the "Embedding configuration mismatch" warning
Bun.env.OM_TIER = "local";
Bun.env.OM_EMBEDDINGS = "local";
Bun.env.OM_DB_PATH = ":memory:";
Bun.env.OM_LOG_LEVEL = "error"; // Reduce noise in tests
Bun.env.OM_TELEMETRY_ENABLED = "false";
Bun.env.OM_TEST_MODE = "true";
Bun.env.OM_API_KEYS = "test-key-123"; // Prevent "No API Keys set" error
Bun.env.OM_ADMIN_KEY = "admin-test-key-456";
Bun.env.OM_REDIS_URL = "redis://localhost:6379";
Bun.env.OM_TEST_TIMEOUT = "30000";

// Initialize test watchdog with aggressive timeouts to prevent stuck tests
initializeTestWatchdog({
    maxExecutionTime: 120000, // 2 minutes absolute maximum for any test
    warningThreshold: 0.7, // Warn at 70% of max time
    checkInterval: 3000, // Check every 3 seconds
    forceKillProcess: true, // Force kill on timeout
    onBeforeTerminate: async () => {
        console.error("[WATCHDOG] Test suite exceeded maximum execution time, forcing cleanup...");
        try {
            await testProcessManager.stopAllProcesses();
            await postTestCleanup();
        } catch (error) {
            console.error("[WATCHDOG] Emergency cleanup failed:", error);
        }
    }
});

// Mock sharp to prevent "Could not load the sharp module" errors
mock.module("sharp", () => {
    return {
        default: () => ({
            resize: () => ({
                toFormat: () => ({
                    toBuffer: async () => Buffer.from("mock-image-buffer"),
                }),
            }),
            metadata: async () => ({ width: 100, height: 100, format: "png" }),
        }),
    };
});

// Global beforeEach - can be skipped by tests that manage their own DB lifecycle
// by setting OM_SKIP_GLOBAL_SETUP=true in their beforeAll
beforeEach(async () => {
    if (Bun.env.OM_SKIP_GLOBAL_SETUP) return;
    if (!Bun.env.OM_KEEP_DB) {
        await closeDb();
    }
    await waitForDb();
    reloadConfig();
});

afterAll(async () => {
    if (Bun.env.OM_SKIP_GLOBAL_SETUP) return;
    
    // Stop watchdog first
    stopTestWatchdog();
    
    // Stop all test processes before closing database
    await testProcessManager.stopAllProcesses();
    
    await closeDb();
    // Clean up test artifacts after all tests complete
    await postTestCleanup();
});

// Set up cleanup on process exit to handle unexpected termination
setupCleanupOnExit();

// Set up process manager shutdown handler
testProcessManager.addShutdownHandler(async () => {
    stopTestWatchdog();
    await closeDb();
    await postTestCleanup();
});

// Run pre-test cleanup when this setup file is loaded
// This ensures we start with a clean slate
if (!Bun.env.OM_SKIP_CLEANUP) {
    preTestCleanup().catch((error) => {
        console.warn("[SETUP] Pre-test cleanup failed:", error);
    });
}
