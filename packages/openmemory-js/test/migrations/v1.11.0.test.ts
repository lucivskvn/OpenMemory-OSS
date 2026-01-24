import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, migrations } from "../../src/core/migrate";
import { get_sq_db, closeDb } from "../../src/core/db";
import { env } from "../../src/core/cfg";

// Mock env for test
env.dbPath = ":memory:";
env.metadataBackend = "sqlite";

describe("Migration v1.11.0", () => {
    beforeAll(async () => {
        // Ensure clean state - run migrations once
        await runMigrations();
    });

    afterAll(async () => {
        await closeDb();
    });

    test("Should run all migrations including v1.11.0 successfully", async () => {
        const db = await get_sq_db();
        // Verify schema version
        const ver = db.prepare("SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1").get() as any;
        // 1.11.0 should have run (along with 1.12.0 if still in list)
        expect(ver).toBeDefined();
        expect(ver.version).toBeDefined();
    });

    test("Should have created new tables", async () => {
        const db = await get_sq_db();
        const tables = ["encryption_keys", "audit_logs", "webhooks", "webhook_logs", "rate_limits", "config", "feature_flags"];
        for (const t of tables) {
            const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`).get();
            expect(exists).toBeTruthy();
        }
    });

    test("Should have added encryption_key_version to memories", async () => {
        const db = await get_sq_db();
        const info = db.prepare("PRAGMA table_info(memories)").all() as any[];
        const col = info.find(c => c.name === "encryption_key_version");
        expect(col).toBeDefined();
        expect(col.dflt_value).toBe("1");
    });

    test("Should be idempotent", async () => {
        // Run migrations again - should not throw
        await runMigrations();
        const db = await get_sq_db();
        const ver = db.prepare("SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1").get() as any;
        expect(ver).toBeDefined();
    });
});
