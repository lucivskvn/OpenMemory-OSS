
import { describe, it, expect, mock, spyOn, beforeAll } from "bun:test";

// Mock ioredis BEFORE importing the class that uses it
const mockRedis = {
    call: mock(async () => []),
    pipeline: mock(() => ({
        hset: mock(),
        sadd: mock(),
        del: mock(),
        srem: mock(),
        exec: mock(async () => [])
    })),
    hget: mock(async () => null),
    hgetall: mock(async () => ({})),
    smembers: mock(async () => []),
    scan: mock(async () => ["0", []]),
    quit: mock(async () => { })
};

mock.module("ioredis", () => {
    return {
        default: class Redis {
            constructor() {
                Object.assign(this, mockRedis);
            }
        }
    };
});

// Dynamic import to ensure mock is registered first
const { ValkeyVectorStore } = await import("../packages/openmemory-js/src/core/vector/valkey");

describe("ValkeyVectorStore", () => {
    let store: InstanceType<typeof ValkeyVectorStore>;

    beforeAll(() => {
        store = new ValkeyVectorStore();
    });

    it("should store a vector", async () => {
        const id = "test-id";
        const sector = "test-sector";
        const vec = [0.1, 0.2, 0.3];

        await store.storeVector(id, sector, vec, 3, "user-1");
        // We expect ensureIndex (FT.INFO or FT.CREATE) to be called
        // And then hset + sadd
        expect(mockRedis.pipeline).toHaveBeenCalled();
    });

    it("should search similar vectors", async () => {
        // Mock FT.SEARCH response [count, key, [field, val, ...]]
        mockRedis.call.mockResolvedValueOnce([1, "vec:test:1", ["id", "1", "score", "0.1", "v", "buffer"]]);

        const res = await store.searchSimilar("test", [0.1, 0.2, 0.3], 1, "user-1");
        expect(res.length).toBe(1);
        expect(res[0].id).toBe("1");
        expect(res[0].score).toBeCloseTo(0.9); // 1 - 0.1
    });

    it("should delete vectors", async () => {
        await store.deleteVector("id", "sector", "user");
        expect(mockRedis.pipeline).toHaveBeenCalled();
    });
});
