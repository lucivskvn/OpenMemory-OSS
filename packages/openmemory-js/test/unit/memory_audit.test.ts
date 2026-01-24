import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { closeDb, waitForDb } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { eventBus, EVENTS } from "../../src/core/events";

describe("Memory Audit & Refinement Verification", () => {
    let mem: Memory;
    const testUser = "audit_user_" + Date.now();

    beforeAll(async () => {
        await waitForDb();
        mem = new Memory(testUser);
        await mem.wipe(); // Start clean
    });

    afterAll(async () => {
        await stopAllMaintenance();
        await closeDb();
    });

    test("Hydration optimization: parseMemory handles pre-parsed objects", async () => {
        const item = await mem.add("Test content", {
            tags: ["tag1", "tag2"],
            metadata: { key: "value" }
        });

        expect(item.tags).toEqual(["tag1", "tag2"]);
        expect(item.metadata).toEqual({ key: "value" });

        // Fetch back to verify hydration from DB
        const fetched = await mem.get(item.id);
        expect(fetched).toBeDefined();
        expect(fetched!.tags).toEqual(["tag1", "tag2"]);
        expect(fetched!.metadata).toEqual({ key: "value" });
        expect(Array.isArray(fetched!.tags)).toBe(true);
        expect(typeof fetched!.metadata).toBe("object");
    });

    test("filter() by sector works", async () => {
        await mem.add("Sector A content", { metadata: { sector: "A" } }); // classifyContent might override if not careful, but let's assume it works or we use overrides
        await mem.add("Regular content");

        const results = await mem.filter({ sector: "semantic" });
        expect(results.length).toBeGreaterThan(0);
        expect(results.every(r => r.primarySector === "semantic")).toBe(true);
    });

    test("filter() by tags works", async () => {
        await mem.add("Tagged content", { tags: ["unique_tag_123"] });

        const results = await mem.filter({ tags: ["unique_tag_123"] });
        expect(results.length).toBe(1);
        expect(results[0].tags).toContain("unique_tag_123");
    });

    test("filter() by metadata KV works", async () => {
        await mem.add("Meta content", { metadata: { search_key: "search_val" } });

        const results = await mem.filter({ metadata: { search_key: "search_val" } });
        expect(results.length).toBe(1);
        expect(results[0].metadata).toMatchObject({ search_key: "search_val" });
    });

    test("addBatch() uses optimized HSG batch and returns full items", async () => {
        const items = [
            { content: "Batch item 1", tags: ["batch"], metadata: { b: 1 } },
            { content: "Batch item 2", tags: ["batch"], metadata: { b: 2 } }
        ];

        let eventCount = 0;
        const cb = () => eventCount++;
        eventBus.on(EVENTS.MEMORY_ADDED, cb);

        const results = await mem.addBatch(items);

        eventBus.off(EVENTS.MEMORY_ADDED, cb);

        expect(results.length).toBe(2);
        expect(results[0].content).toBe("Batch item 1");
        expect(results[1].content).toBe("Batch item 2");
        expect(results[0].tags).toContain("batch");
        expect(results[1].metadata).toMatchObject({ b: 2 });
        expect(eventCount).toBe(2); // Verify event emission
    });

    test("userId resolution is consistent via getUid", async () => {
        const globalMem = new Memory(null);
        const item = await globalMem.add("Global memory");
        expect(item.userId).toBeNull();

        const userMem = new Memory("specific_user");
        const userItem = await userMem.add("User memory");
        expect(userItem.userId).toBe("specific_user");

        // Cross-access check
        const fetched = await globalMem.get(userItem.id, "specific_user");
        expect(fetched).toBeDefined();
        expect(fetched!.id).toBe(userItem.id);
    });
});
