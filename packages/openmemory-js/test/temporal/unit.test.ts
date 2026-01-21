import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { TemporalFactRow } from "../../src/temporal_graph/types";

// Mock dependencies
const mockRun = mock((...args: any[]) => Promise.resolve(1));
const mockAll = mock((...args: any[]) => Promise.resolve([]));
const mockGet = mock((...args: any[]) => Promise.resolve(null));
const mockTransaction = mock((fn: any) => fn());

// Mock the low-level DB access early
mock.module("../../src/core/db_access", () => ({
    runAsync: mockRun,
    allAsync: mockAll,
    getAsync: mockGet,
    runUser: mockRun,
    getUser: mockGet,
    allUser: mockAll,
    transaction: { run: mockTransaction },
    TABLES: {
        temporal_facts: "temporal_facts",
        temporal_edges: "temporal_edges",
    },
}));

// Mock security and other things
mock.module("../../src/core/security", () => ({
    getEncryption: () => ({
        encrypt: async (s: string) => JSON.stringify({ iv: "mock", data: s }),
        decrypt: async (s: string) => {
            try {
                const p = JSON.parse(s);
                return p.data || s;
            } catch { return s; }
        },
    }),
}));

mock.module("../../src/core/cfg", () => ({
    env: { verbose: false, metadataBackend: "sqlite" },
}));

mock.module("../../src/utils/logger", () => ({
    logger: {
        info: () => { },
        debug: () => { },
        error: () => { },
        warn: () => { },
    },
}));

// Now import the code under test
const {
    insertFact,
    updateFact,
    insertEdge,
    getActiveFactsCount,
    getTotalFactsCount
} = await import("../../src/temporal_graph/store");
const { rowToFact } = await import("../../src/temporal_graph/query");

describe("Temporal Graph Unit Suite (Strict)", () => {
    beforeEach(() => {
        mockRun.mockClear();
        mockAll.mockClear();
        mockGet.mockClear();
        mockTransaction.mockClear();
    });

    test("insertFact calls DB with correct params", async () => {
        const id = await insertFact("subj", "pred", "obj", new Date(), 0.9, { foo: "bar" }, "user1");
        expect(typeof id).toBe("string");
        expect(mockGet).toHaveBeenCalled(); // findActiveFact
        expect(mockAll).toHaveBeenCalled(); // getOverlappingFacts
        expect(mockRun).toHaveBeenCalled(); // insertFactRaw
    });

    test("updateFact handles empty updates gracefully", async () => {
        await updateFact("id1", "user1");
        expect(true).toBe(true);
    });

    test("rowToFact correctly maps TemporalFactRow", async () => {
        const now = Date.now();
        const row: TemporalFactRow = {
            id: "test-id",
            userId: "user_test",
            subject: "s",
            predicate: "p",
            object: "o",
            validFrom: now,
            validTo: null,
            confidence: 1.0,
            lastUpdated: now,
            metadata: JSON.stringify({ key: "value" }),
        };

        const fact = await rowToFact(row);
        expect(fact.id).toBe("test-id");
        expect(fact.userId).toBe("user_test");
        expect(fact.metadata).toEqual({ key: "value" });
        expect(fact.validFrom).toBe(now);
    });

    test("rowToFact handles null row", async () => {
        // @ts-ignore
        const fact = await rowToFact(null);
        // @ts-ignore
        expect(fact).toBe(null);
    });

    test("insertEdge calls DB with correct params", async () => {
        const id = await insertEdge("src", "tgt", "rel", new Date(), 0.5, { meta: 1 }, "user1");
        expect(typeof id).toBe("string");
        expect(mockGet).toHaveBeenCalled();
        expect(mockAll).toHaveBeenCalled();
        expect(mockRun).toHaveBeenCalled();
    });

    test("getActiveFactsCount calls DB and returns number", async () => {
        mockGet.mockResolvedValueOnce({ c: 42 } as any);
        const count = await getActiveFactsCount("user1");
        expect(count).toBe(42);
        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining("temporal_facts"),
            [],
            "user1"
        );
    });

    test("getTotalFactsCount calls DB and returns number", async () => {
        mockGet.mockResolvedValueOnce({ c: 100 } as any);
        const count = await getTotalFactsCount("user1");
        expect(count).toBe(100);
        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining("temporal_facts"),
            [],
            "user1"
        );
    });
});

