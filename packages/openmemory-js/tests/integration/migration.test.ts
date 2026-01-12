import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { runMigrations } from "../../src/core/migrate"; // We'll need to mock env or db path
import { Database } from "bun:sqlite";
import { env, reloadConfig } from "../../src/core/cfg";

// Mocking env to force SQLite usage and a unique path
const TEST_DB_PATH = ":memory:";

// We need to hijack the `process.env` or the way `runMigrations` gets its DB.
// Since `runMigrations` instantiates `Database` internally based on `process.env.OM_DB_PATH` if not PG.

describe("Database Migrations", () => {
    // Preserve original env
    const originalMetadataBackend = env.metadataBackend;
    const originalDbPath = process.env.OM_DB_PATH;

    beforeAll(() => {
        // Force SQLite
        // env is a singleton parsed at startup, so modifying process.env might not affect 'env' object if it's already frozen?
        // Let's check `migrate.ts`: uses `isPg = env.metadataBackend === "postgres"`.
        // We might need to rely on the fact that `env` reads from process.env, OR we need to mock the module.
        // But `env` is imported.
        // Actually, `migrate.ts` checks `isPg` at module level const. That's a problem for testing if already loaded.
        // However, Bun test runner isolates tests? No, imports are cached.

        // Strategy: We can't easily change `isPg` constant if it turned true.
        // But default likely isn't postgres unless configured.
        // Assuming default is sqlite.
    });

    test("Run Migrations on :memory: DB", async () => {
        // We can't inject the DB instance into `runMigrations` currently. 
        // It creates its own `new Database(dbPath)`.
        // We'll modify `process.env.OM_DB_PATH` to a file we can check, or just rely on no errors.
        // :memory: is tricky because `runMigrations` opens it, runs, closes it. 
        // If it closes, data is lost. We can't verify tables.

        // Fix: Use a temp file for persistence across the open/close in runMigrations and our verification.
        const tempDb = `./test_migration_${Date.now()}.sqlite`;
        process.env.OM_DB_PATH = tempDb;
        reloadConfig(); // <--- CRITICAL FIX

        try {
            // 1. First Run
            console.log("Running migrations (1st time)...");
            await runMigrations();

            // Verify
            const db = new Database(tempDb);
            const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
            const tableNames = tables.map(t => t.name);

            expect(tableNames).toContain("memories");
            expect(tableNames).toContain("vectors");
            expect(tableNames).toContain("temporal_facts");
            expect(tableNames).toContain("schema_version");

            const ver = db.query("SELECT version FROM schema_version").get() as { version: string };
            expect(ver.version).toBeDefined();

            db.close();

            // 2. Idempotency Run
            console.log("Running migrations (2nd time)...");
            await runMigrations(); // Should succeed and do nothing

        } finally {
            // Cleanup
            const fs = await import("fs");
            if (fs.existsSync(tempDb)) {
                fs.unlinkSync(tempDb);
            }
            process.env.OM_DB_PATH = originalDbPath;
        }
    });
});
