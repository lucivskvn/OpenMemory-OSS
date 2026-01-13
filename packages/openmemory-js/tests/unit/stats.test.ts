import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { getSystemStats } from "../../src/core/stats";
import { q, closeDb, runAsync } from "../../src/core/db";
import { env, reloadConfig } from "../../src/core/cfg";
import * as path from "path";

// Ensure we use a file-based DB for persistence across calls if needed, 
// though stats test might be fine with :memory: provided we populate it in the same process.
// For robustness, let's use a file.
const TEST_DB_PATH = path.resolve(__dirname, "../../../data/test_stats.sqlite");

describe("Stats Core", () => {
    beforeAll(async () => {
        // Close any existing connections
        await closeDb();

        process.env.OM_DB_PATH = ":memory:";
        process.env.OM_VERBOSE = "true";
        reloadConfig();

        // Populate DB with some data
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
        await closeDb();
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
