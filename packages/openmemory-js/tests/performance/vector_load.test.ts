
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { q, closeDb } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { now } from "../../src/utils";

// Performance Test: Vector Load & Scalability
// Targeted at checking QPS for bulk ingestion and index/search constraints.
describe("Vector Performance: Load Test", () => {
    let memory: Memory;

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        process.env.OM_VERBOSE = "false";
        await reloadConfig();
        memory = new Memory();
        // Memory initializes lazily on first call
    });

    afterAll(async () => {
        await closeDb();
    });

    test("Bulk Ingestion: 1000 Memories", async () => {
        const COUNT = 1000;
        const start = now();

        const items = Array.from({ length: COUNT }, (_, i) => ({
            content: `Performance test memory content #${i} about scaling and vectors.`,
            tags: ["perf", `item-${i}`]
        }));

        // Use Promise.all with concurrency limit is realistic, 
        // but Memory.add is atomic. Let's do batches of 50.
        const BATCH_SIZE = 50;
        for (let i = 0; i < COUNT; i += BATCH_SIZE) {
            const batch = items.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(item => memory.add(item.content, { tags: item.tags, userId: "perf-user" })));
        }

        const duration = now() - start;
        const qps = (COUNT / (duration / 1000)).toFixed(2);
        console.log(`[PERF] Ingested ${COUNT} items in ${duration}ms. QPS: ${qps}`);

        expect(duration).toBeLessThan(30000); // Expect > 33 QPS roughly (very conservative for SQLite)
    }, 60000);

    test("Vector Search Latency", async () => {
        // Ensure index is hit
        const start = now();
        const results = await memory.search("scaling vectors", { userId: "perf-user", limit: 50 });
        const duration = now() - start;

        console.log(`[PERF] Vector Search (Limit 50) took ${duration}ms.`);
        expect(results.length).toBeGreaterThan(0);
        expect(duration).toBeLessThan(1000); // Sub-second search is mandatory
    });
});
