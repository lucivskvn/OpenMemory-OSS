import { beforeEach, afterAll, mock } from "bun:test";
import { closeDb, waitForDb } from "../src/core/db";
import { reloadConfig } from "../src/core/cfg";

// Set consistent test environment BEFORE any imports that read env
// This prevents the "Embedding configuration mismatch" warning
Bun.env.OM_TIER = "local";
Bun.env.OM_EMBEDDINGS = "local";
Bun.env.OM_DB_PATH = ":memory:";
Bun.env.OM_LOG_LEVEL = "warn";
Bun.env.OM_TELEMETRY_ENABLED = "false";

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
    await closeDb();
});
