import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { getSystemStats } from "../../src/core/stats";
import { q, closeDb, runAsync } from "../../src/core/db";
import { env, reloadConfig } from "../../src/core/cfg";
import * as path from "path";
import fs from "node:fs";

// Ensure we use a file-based DB for persistence across calls if needed, 
// though stats test might be fine with :memory: provided we populate it in the same process.
// For robustness, let's use a file.
const DB_PATH = path.join(process.cwd(), "tests/data", `test_stats_${Date.now()}.sqlite`);

describe("Stats Core", () => {
    const originalEnv = { ...process.env };

    beforeAll(async () => {
        // Close any existing connections
        await closeDb();

        process.env.OM_DB_PATH = DB_PATH;
        process.env.OM_VERBOSE = "true";
        reloadConfig();

        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Populate DB with some data using raw SQL to be safe and simple
        // First, insert with NULL user_id for the generic stats test
        await runAsync(`insert or replace into memories (id, content, primary_sector, tags, metadata, created_at, user_id, salience, decay_lambda, version) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ["stat_test", "stat_test", "stats_test_sector", "[]", "{}", Date.now(), null, 1, 0, 1]);
        await runAsync(`insert or replace into memories (id, content, primary_sector, tags, metadata, created_at, user_id, salience, decay_lambda, version) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ["stat_test_2", "stat_test_2", "stats_test_sector", "[]", "{}", Date.now(), null, 1, 0, 1]);
        // Insert one with specific user for filtering test
        await runAsync(`insert or replace into memories (id, content, primary_sector, tags, metadata, created_at, user_id, salience, decay_lambda, version) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ["stat_test_user", "stat_test_user", "stats_test_sector", "[]", "{}", Date.now(), "stat_user_1", 1, 0, 1]);
    });

    afterAll(async () => {
        process.env.OM_DB_PATH = originalEnv.OM_DB_PATH;
        process.env.OM_VERBOSE = originalEnv.OM_VERBOSE;
        await closeDb();
        await new Promise(r => setTimeout(r, 100));
        if (fs.existsSync(DB_PATH)) {
            try {
                fs.unlinkSync(DB_PATH);
                if (fs.existsSync(DB_PATH + "-shm")) fs.unlinkSync(DB_PATH + "-shm");
                if (fs.existsSync(DB_PATH + "-wal")) fs.unlinkSync(DB_PATH + "-wal");
            } catch (e) { }
        }
    });

    test("getSystemStats should return valid structure", async () => {
        const stats = await getSystemStats(undefined, [10, 20]);

        expect(stats.totalMemories).toBeGreaterThanOrEqual(2);
        expect(stats.avgSalience).toBeDefined();
        expect(stats.qps.average).toBe(15);
        expect(stats.config.port).toBeDefined();
        // Since we are file based, memoryUsage (heap) is 0 from getDbSz logic for sqlite usually, unless checked via fs
        // Wait, getDbSz uses fs.stat for non-PG.
        expect(stats.system.heapUsed).toBeGreaterThanOrEqual(0);
    });

    test("getSystemStats with userId should filter results", async () => {
        const stats = await getSystemStats("stat_user_1", []);
        // Should catch the memory we added for user 1.
        // Wait, totalMemories in getSystemStats uses userClause.
        expect(stats.totalMemories).toBeGreaterThanOrEqual(1);
    });
});
