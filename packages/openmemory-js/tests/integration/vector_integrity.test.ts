import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { q, vectorStore, closeDb } from "../../src/core/db";
import { addMemory } from "../../src/memory/hsg";
import { cleanupOrphanedVectors } from "../../src/ops/vector_maint";
import { sleep } from "../../src/utils";
import { reloadConfig } from "../../src/core/cfg";

describe("Vector Storage Integrity & Orphan Cleanup", () => {
    const userId = "test-vector-maint-user";

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
        // Ensure ready
        const { waitReady } = await import("../../src/core/db");
        await waitReady();
    });

    afterAll(async () => {
        await closeDb();
    });

    it("should correctly identify and remove orphaned vectors", async () => {
        const orphanId = "orphan-id-" + Date.now();

        // 1. Manually store a vector without a matching memory
        await vectorStore.storeVector(orphanId, "episodic", new Array(768).fill(0), 768, userId);

        // Verify vector exists
        const beforeIds = await vectorStore.getAllVectorIds();
        expect(beforeIds.has(orphanId)).toBe(true);

        // Verify memory DOES NOT exist
        const mem = await q.getMem.get(orphanId, userId);
        expect(mem).toBeUndefined();

        // 2. Run cleanup
        const result = await cleanupOrphanedVectors();
        expect(result.deleted).toBeGreaterThanOrEqual(1);

        // 3. Verify vector is now gone
        const afterIds = await vectorStore.getAllVectorIds();
        expect(afterIds.has(orphanId)).toBe(false);
    });

    it("should not delete valid vectors", async () => {
        // 1. Create a valid memory
        const mem = await addMemory("Valid persistent memory", userId);

        // 2. Run cleanup
        const result = await cleanupOrphanedVectors();

        // 3. Verify vector still exists
        const finalIds = await vectorStore.getAllVectorIds();
        expect(finalIds.has(mem.id)).toBe(true);
    });
});
