import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { hsgQuery } from "../../src/memory/hsg";
import { q } from "../../src/core/db";
import { eventBus } from "../../src/core/events";

// Performance thresholds
const THRESHOLDS = {
    QUERY_P95_MS: 50,
    MEMORY_LEAK_TOLERANCE_MB: 50,
};

describe("System Performance & Sustainability", () => {
    let initialMemoryUsage: number;
    const testUserId = "perf_test_user";

    beforeAll(async () => {
        const used = process.memoryUsage().heapUsed / 1024 / 1024;
        initialMemoryUsage = used;
        console.log(`[PERF] Initial Heap: ${used.toFixed(2)} MB`);

        // Seed Data
        const mem = new Memory(testUserId);
        const seeds = Array.from({ length: 100 }, (_, i) => ({
            content: `Performance test memory content ${i} with some unique entropy ${Math.random()}`,
            tags: ["perf_test"],
            primarySector: "semantic"
        }));
        // Use parallel add if batch method undefined
        await Promise.all(seeds.map(s => mem.add(s.content, { tags: s.tags, sector: s.primarySector })));
    });

    afterAll(async () => {
        const mem = new Memory(testUserId);
        await mem.deleteAll(testUserId);
    });

    test("Query Latency (P95) should be within limits", async () => {
        const latencies: number[] = [];
        const iterations = 50;

        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            await hsgQuery("Performance test memory", 5, { userId: testUserId });
            latencies.push(performance.now() - start);
        }

        latencies.sort((a, b) => a - b);
        const p95 = latencies[Math.floor(iterations * 0.95)];
        const avg = latencies.reduce((a, b) => a + b, 0) / iterations;

        console.log(`[PERF] Query Latency - P95: ${p95.toFixed(2)}ms, Avg: ${avg.toFixed(2)}ms`);
        expect(p95).toBeLessThan(THRESHOLDS.QUERY_P95_MS);
    });

    test("Memory Usage should be stable after intensive operations", async () => {
        // Run a burst of activity
        const iterations = 100;
        const promises = [];
        for (let i = 0; i < iterations; i++) {
            promises.push(hsgQuery("frequent access pattern", 1, { userId: testUserId }));
        }
        await Promise.all(promises);

        // Force GC if possible (Bun/Node usually requires flags, so we check trend)
        if (global.gc) global.gc();

        const finalUsed = process.memoryUsage().heapUsed / 1024 / 1024;
        const diff = finalUsed - initialMemoryUsage;

        console.log(`[PERF] Final Heap: ${finalUsed.toFixed(2)} MB (Diff: ${diff.toFixed(2)} MB)`);

        // This is a loose check as GC behavior is non-deterministic, but catches massive leaks
        // expecting some growth due to caching is normal.
        expect(diff).toBeLessThan(THRESHOLDS.MEMORY_LEAK_TOLERANCE_MB);
    });

    test("Event Bus listener count should be stable", () => {
        const listeners = eventBus.eventNames().map(e => eventBus.listenerCount(e));
        const total = listeners.reduce((a, b) => a + b, 0);
        console.log(`[PERF] Total Event Listeners: ${total}`);
        expect(total).toBeLessThan(50); // Arbitrary sanity limit
    });
});
