import { describe, it, expect } from "bun:test";
import { PostgresVectorStore } from "../../src/core/vector/postgres";

// Mock DbOps
const makeDb = (rows: any[]) => ({
    run_async: async () => {},
    get_async: async () => null,
    all_async: async (sql: string, params?: any[]) => rows,
});

describe("PostgresVectorStore search behavior", () => {
    it("falls back to in-memory cosine sim when pgvector not available", async () => {
        // Simulate rows with bytea v as Buffer
        const fakeRows = [
            { id: "a", v: Buffer.from(new Float32Array([1, 0]).buffer), dim: 2 },
            { id: "b", v: Buffer.from(new Float32Array([0.9, 0.1]).buffer), dim: 2 },
        ];
        const db = makeDb(fakeRows as any[]);
        const store = new PostgresVectorStore(db as any, "vectors");
        // ensure pgvectorAvailable is false (default)
        (store as any).pgvectorAvailable = false;
        const res = await store.searchSimilar("semantic", [1, 0], 2);
        expect(res.length).toBe(2);
        expect(res[0].id).toBe("a");
    });

    it("uses pgvector path when available and DB returns distances", async () => {
        // Mock DB to return rows with dist
        const db = makeDb([{ id: "x", dist: "0.1" }, { id: "y", dist: "1.5" }]);
        const store = new PostgresVectorStore(db as any, "vectors");
        (store as any).pgvectorAvailable = true;
        const res = await store.searchSimilar("semantic", [0, 1], 2);
        expect(res.length).toBe(2);
        // dist -> score = 1/(1+dist); smaller dist => larger score, so 'x' first
        expect(res[0].id).toBe("x");
        expect(res[0].score).toBeGreaterThan(res[1].score);
    });
});
