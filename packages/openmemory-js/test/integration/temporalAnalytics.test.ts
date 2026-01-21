import { describe, expect, beforeAll, afterAll } from "bun:test";
import { test as it, cleanupIfSuccess, waitForDb, getUniqueDbPath } from "../test_utils";
import { insertFact, deleteFact } from "../../src/temporal_graph/store";
import { getChangeFrequency, compareTimePoints, getSubjectTimeline } from "../../src/temporal_graph/timeline";
import { TABLES, runAsync, closeDb } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";

import path from "node:path";
import fs from "node:fs";

describe("Phase 113: Temporal Analytics & Aggregation", () => {
    const userId = "test-user-" + Date.now();
    const subject = "OpenMemory";
    const predicate = "version";
    let dbPath;

    beforeAll(async () => {
        process.env.OM_KEEP_DB = "true";
        dbPath = getUniqueDbPath("test_analytics");
        process.env.OM_DB_PATH = dbPath;
        reloadConfig();

        await waitForDb();
    }, 10000);

    afterAll(async () => {
        await cleanupIfSuccess(dbPath);
    });

    it("should correctly calculate change frequency including active facts", async () => {
        const now = Date.now();
        // Insert an old fact that was closed
        const f1Start = now - (10 * 86400000); // 10 days ago
        const f2Start = now - (5 * 86400000);  // 5 days ago

        await insertFact(subject, predicate, "v1.0", new Date(f1Start), 1.0, {}, userId);
        // This implicitly closes v1.0 at f2Start - 1
        await insertFact(subject, predicate, "v2.0", new Date(f2Start), 1.0, {}, userId);

        const freq = await getChangeFrequency(subject, predicate, 30, userId);

        // v1.0 duration: approx 5 days
        // v2.0 duration: approx 5 days (since it's active)
        // avgDurationMs should be approx 5 days
        const fiveDaysMs = 5 * 86400000;
        expect(freq.totalChanges).toBe(2);
        expect(freq.avgDurationMs).toBeGreaterThan(fourDaysMs); // Buffer for small diffs
        expect(freq.avgDurationMs).toBeLessThan(sixDaysMs);
    });

    it("should consolidate state correctly in compareTimePoints", async () => {
        const now = Date.now();
        const t1 = new Date(now - (8 * 86400000)); // middle of v1.0
        const t2 = new Date(now - (2 * 86400000)); // middle of v2.0

        const comparison = await compareTimePoints(subject, t1, t2, userId);

        expect(comparison.changed.length).toBe(1);
        expect(comparison.changed[0].before.object).toBe("v1.0");
        expect(comparison.changed[0].after.object).toBe("v2.0");
    });

    it("should maintain a sorted timeline even with multiple facts", async () => {
        const timeline = await getSubjectTimeline(subject, predicate, userId);
        expect(timeline.length).toBeGreaterThanOrEqual(3); // created, invalidated, created (v2 is active so no invalidated yet)

        // Verify chronological order
        for (let i = 1; i < timeline.length; i++) {
            expect(timeline[i].timestamp).toBeGreaterThanOrEqual(timeline[i - 1].timestamp);
        }
    });
});

const fourDaysMs = 4 * 86400000;
const sixDaysMs = 6 * 86400000;
