
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SqlVectorStore } from "../../src/core/vector/sql";
import { q, runAsync, getAsync, allAsync, iterateAsync, transaction } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { vectorToBuffer } from "../../src/utils/vectors";

// Mock DbOps wrapping the real DB helpers
const dbOps = {
    runAsync,
    getAsync,
    allAsync,
    transaction: transaction.run,
    iterateAsync
};

describe("SqlVectorStore Integrity", () => {
    let store: SqlVectorStore;
    const testId = "vec_test_" + Date.now();
    const testSector = "test_sector";
    const userId = "user_" + Date.now();

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
        store = new SqlVectorStore(dbOps, "vectors");
        // Ensure table exists (SQLite usually creates it via setup, but we want to be sure)
        // In full app, migrations handle this. We assume existing env or "vectors" table presence.
        // If not, we might need to create a temp table?
        // Let's assume the standard 'vectors' table exists for now.
    });

    afterAll(async () => {
        // Cleanup
        await store.deleteVector(testId, testSector, userId);
        await store.deleteVectorsByUser(userId);
    });

    test("storeVector and getVector (Round Trip)", async () => {
        const dim = 4;
        const vec = [0.1, 0.2, 0.3, 0.4];

        await store.storeVector(testId, testSector, vec, dim, userId, { meta: "data" });

        const retrieved = await store.getVector(testId, testSector, userId);
        expect(retrieved).not.toBeNull();
        expect(retrieved?.dim).toBe(dim);
        expect(retrieved?.vector.length).toBe(dim);
        // Float precision check
        expect(retrieved?.vector[0]).toBeCloseTo(0.1);
    });

    test("searchSimilar (Exact Match)", async () => {
        const vec = [0.1, 0.2, 0.3, 0.4];
        const res = await store.searchSimilar(testSector, vec, 5, userId);

        expect(res.length).toBeGreaterThan(0);
        expect(res[0].id).toBe(testId);
        expect(res[0].score).toBeGreaterThan(0.999);
    });

    test("searchSimilar (Metadata Filter)", async () => {
        const vec = [0.1, 0.2, 0.3, 0.4];
        // Match
        const res1 = await store.searchSimilar(testSector, vec, 5, userId, { metadata: { meta: "data" } });
        expect(res1.length).toBeGreaterThan(0);

        // No Match
        const res2 = await store.searchSimilar(testSector, vec, 5, userId, { metadata: { meta: "wrong" } });
        expect(res2.length).toBe(0);
    });

    test("deleteVectorsByUser", async () => {
        await store.deleteVectorsByUser(userId);
        const res = await store.getVector(testId, testSector, userId);
        expect(res).toBeNull();
    });
});
