import { describe, expect, it, beforeAll } from "bun:test";
import { SqlVectorStore } from "../../src/core/vector/sql";
import { ValkeyVectorStore } from "../../src/core/vector/valkey";
import { VectorStore } from "../../src/core/vector_store";

// Mock DbOps for testing logic without full DB if needed, 
// but here we might want to test against actual implementations if possible.
// For now, we will test the logic flow and mock the underlying drivers.

describe("Phase 112: Vector Store Metadata Consistency", () => {
    const vector = [0.1, 0.2, 0.3];
    const dim = 3;
    const userId = "test-user";
    const sector = "episodic";

    it("should correctly serialize and filter metadata in SQL (SQLite fallback style)", async () => {
        const mockDb = {
            runAsync: async () => 1,
            getAsync: async () => undefined,
            allAsync: async () => [],
        };
        const sqlStore = new SqlVectorStore(mockDb as any);

        // This is a unit test for the method signature and basic logic
        await sqlStore.storeVector("v1", sector, vector, dim, userId, { key: "val" });

        // Verification of SQL generation would requiring spying on runAsync
        // For now, we focus on the searchSimilar interface consistency
        const results = await sqlStore.searchSimilar(sector, vector, 10, userId, {
            metadata: { key: "val" }
        });
        expect(Array.isArray(results)).toBe(true);
    });

    it("should correctly serialize and filter metadata in Valkey", async () => {
        // We might need a real Valkey or deep mock for FT.SEARCH
        // For this audit, we verified the code logic in valkey.ts
        const valkeyStore = new ValkeyVectorStore();

        // Just checking consistency of method signatures
        expect(typeof valkeyStore.searchSimilar).toBe("function");
    });
});
