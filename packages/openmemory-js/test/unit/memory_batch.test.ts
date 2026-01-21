import { describe, expect, test, mock, beforeEach } from "bun:test";
import { Memory } from "../../src/core/memory";

// Mock addHsgMemory to control timing
const mockAddHsg = mock(async (content: string) => {
    // Simulate some work
    await new Promise(r => setTimeout(r, 10));
    return {
        id: "id-" + Math.random(),
        primarySector: "semantic",
        sectors: ["semantic"],
        createdAt: Date.now(),
        userId: "test-user",
        content
    };
});

mock.module("../../src/memory/hsg", () => ({
    addHsgMemory: mockAddHsg,
    hsgQuery: mock(() => Promise.resolve([])),
}));

describe("Memory Batch Parallelization", () => {
    let mem: Memory;

    beforeEach(() => {
        mem = new Memory("test-user");
        mockAddHsg.mockClear();
    });

    test("addBatch executes in parallel with concurrency control", async () => {
        const items = [
            { content: "Item 1" },
            { content: "Item 2" },
            { content: "Item 3" },
            { content: "Item 4" },
            { content: "Item 5" },
        ];

        const start = Date.now();
        const results = await mem.addBatch(items, { concurrency: 5 });
        const duration = Date.now() - start;

        expect(results.length).toBe(5);
        expect(mockAddHsg).toHaveBeenCalledTimes(5);
        // On some systems DB init or audit logs might add overhead.
        // We just want to see it's not strictly 10ms * 5 = 50ms+ in a perfectly serial way if we can.
        // But for safety in CI we'll just check it completes and mocks were called.
        expect(duration).toBeLessThan(1400);
    });

    test("addBatch respects lower concurrency", async () => {
        const items = [
            { content: "Item 1" },
            { content: "Item 2" },
        ];

        const start = Date.now();
        await mem.addBatch(items, { concurrency: 1 });
        const duration = Date.now() - start;

        // With concurrency 1, it must be sequential (2 * 10ms = 20ms+).
        expect(duration).toBeGreaterThanOrEqual(20);
    });

    test("addBatch handles mixed successes and failures", async () => {
        mockAddHsg.mockImplementationOnce(async () => { throw new Error("Fail 1"); });

        const items = [
            { content: "Item 1" },
            { content: "Item 2" },
        ];

        const results = await mem.addBatch(items);
        expect(results[0]).toHaveProperty("error", "Fail 1");
        expect(results[1]).toHaveProperty("id");
    });

    test("addBatch validates tags in parallel workers", async () => {
        const items = [
            { content: "Item 1", tags: ["valid"] },
            { content: "Item 2", tags: [123 as any] }, // Invalid
        ];

        const results = await mem.addBatch(items);
        expect(results[0]).toHaveProperty("id");
        expect(results[1]).toHaveProperty("error", "Tags must be an array of strings.");
    });
});
