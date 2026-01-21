import { describe, test, expect, spyOn, mock } from "bun:test";
import { SqlVectorStore, DbOps } from "../../src/core/vector/sql";
import { bufferToVector, vectorToBuffer } from "../../src/utils/vectors";

describe("SqlVectorStore", () => {
    // Mock DbOps
    const mockDb: DbOps = {
        runAsync: mock(async () => 1),
        getAsync: mock(async () => undefined),
        allAsync: mock(async () => []),
        iterateAsync: mock(async function* () { yield [] as any; }) // Mock generator with any cast
    };

    const store = new SqlVectorStore(mockDb, "vectors");

    test("storeVector should call runAsync with buffer", async () => {
        const vec = [0.1, 0.2, 0.3];
        await store.storeVector("abc", "semantic", vec, 3);
        expect(mockDb.runAsync).toHaveBeenCalled();
        const callArgs = (mockDb.runAsync as any).mock.lastCall;
        expect(callArgs[0]).toContain("insert into vectors");
        // Check if vector was converted to buffer
        const passedBuffer = callArgs[1][3];
        expect(passedBuffer).toBeInstanceOf(Uint8Array);
    });

    test("getVectorsByIds should use ? placeholders", async () => {
        await store.getVectorsByIds(["a", "b", "c"]);
        const callArgs = (mockDb.allAsync as any).mock.lastCall;
        // Verify we passed 3 question marks
        expect(callArgs[0]).toContain("IN (?,?,?)");
    });

    test("searchSimilar fallback should handle rows", async () => {
        // Mock return with some vector data
        const vec = [0.1, 0.2, 0.3];
        const vBuf = Buffer.from(new Float32Array(vec).buffer);

        // Implementation uses iterateAsync for fallback, not allAsync
        (mockDb.iterateAsync as any).mockImplementation(async function* () {
            yield { id: "1", v: vBuf, dim: 3 };
        });

        const res = await store.searchSimilar("semantic", [0.1, 0.2, 0.3], 5);
        expect(res).toHaveLength(1);
        expect(res[0].id).toBe("1");
        expect(res[0].score).toBeCloseTo(1.0); // Identical vectors
    });

    test("searchSimilar should handle empty query", async () => {
        // This is implicit in logic, but good to check it doesn't crash on mocked return
        (mockDb.allAsync as any).mockResolvedValueOnce([]);
        const res = await store.searchSimilar("semantic", [0.1, 0.2], 5);
        expect(res).toHaveLength(0);
    });
});
