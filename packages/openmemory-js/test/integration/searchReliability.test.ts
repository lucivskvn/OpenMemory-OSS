/**
 * @file Search Reliability Verification Test
 * Tests the keyword fallback mechanism when embeddings fail.
 */
import { expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { test, cleanupIfSuccess, waitForDb, getUniqueDbPath } from "../test_utils";
import { Memory } from "../../src/core/memory";
import * as embed from "../../src/memory/embed";
import { q, closeDb } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = getUniqueDbPath("search_rel");

describe("Search Reliability (Keyword Fallback)", () => {
    beforeAll(async () => {
        await closeDb();
        process.env.OM_DB_PATH = DB_PATH;
        reloadConfig();

        await waitForDb();

        await q.clearAll.run();
    }, 10000);

    afterAll(async () => {
        await cleanupIfSuccess(DB_PATH);
    });

    test("should fallback to keyword search when embedQueryForAllSectors fails", async () => {
        const mem = new Memory("test-user");

        // 1. Add some memories
        await mem.add("The quick brown fox jumps over the lazy dog", { tags: ["animal", "jumping"] });
        await mem.add("OpenMemory is a high-performance cognitive graph", { tags: ["ai", "graph"] });
        await mem.add("The lazy dog sleeps under the tree", { tags: ["animal", "sleeping"] });

        // 2. Mock embedding failure
        const embedSpy = spyOn(embed, "embedQueryForAllSectors").mockImplementation(async () => {
            throw new Error("Simulated embedding failure");
        });

        try {
            // 3. Perform search
            const results = await mem.search("OpenMemory");

            // 4. Verify results
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].content).toContain("OpenMemory");
            expect(embedSpy).toHaveBeenCalled();
            console.log("Keyword fallback search succeeded!");
        } finally {
            embedSpy.mockRestore();
        }
    });

    test("should fallback to keyword search when searching for tags", async () => {
        const mem = new Memory("test-user");

        // Mock embedding failure
        const embedSpy = spyOn(embed, "embedQueryForAllSectors").mockImplementation(async () => {
            throw new Error("Simulated embedding failure");
        });

        try {
            // Search for something specifically in tags
            const results = await mem.search("jumping");

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].tags).toContain("jumping");
        } finally {
            embedSpy.mockRestore();
        }
    });
});
