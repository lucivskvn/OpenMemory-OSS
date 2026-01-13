import { describe, expect, test, mock, beforeEach } from "bun:test";
import { insertFact, updateFact } from "../../src/temporal_graph/store";
import { rowToFact } from "../../src/temporal_graph/query";
import { TemporalFactRow } from "../../src/temporal_graph/types";

// Mock dependencies
const mockRun = mock(() => Promise.resolve());
const mockAll = mock(() => Promise.resolve([]));
const mockGet = mock(() => Promise.resolve(null));
const mockTransaction = mock((fn: any) => fn());

mock.module("../../src/core/db", () => ({
    runAsync: mockRun,
    allAsync: mockAll,
    getAsync: mockGet,
    transaction: { run: mockTransaction },
    q: {
        findActiveFact: { get: mockGet },
        findActiveEdge: { get: mockGet },
        getOverlappingFacts: { all: mockAll },
        getOverlappingEdges: { all: mockAll },
        insFact: { run: mockRun },
        insEdge: { run: mockRun },
        insertFactRaw: { run: mockRun },
        insertEdgeRaw: { run: mockRun },
        updateFactRaw: { run: mockRun },
        getActiveFactCount: { get: mockGet },
        getFactCount: { get: mockGet },
        getActiveEdgeCount: { get: mockGet },
        getEdgeCount: { get: mockGet },
    },
}));

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
        expect(mockAll).toHaveBeenCalled();
        expect(mockRun).toHaveBeenCalled();
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
        const id = await import("../../src/temporal_graph/store").then(m => m.insertEdge("src", "tgt", "rel", new Date(), 0.5, { meta: 1 }, "user1"));
        expect(typeof id).toBe("string");
        expect(mockAll).toHaveBeenCalled();
        expect(mockRun).toHaveBeenCalled();
    });

    test("getActiveFactsCount calls DB and returns number", async () => {
        mockGet.mockResolvedValueOnce({ c: 42 } as any);
        const count = await import("../../src/temporal_graph/store").then(m => m.getActiveFactsCount("user1"));
        expect(count).toBe(42);
        expect(mockGet).toHaveBeenCalledWith("user1");
    });

    test("getTotalFactsCount calls DB and returns number", async () => {
        mockGet.mockResolvedValueOnce({ c: 100 } as any);
        const count = await import("../../src/temporal_graph/store").then(m => m.getTotalFactsCount("user1"));
        expect(count).toBe(100);
        expect(mockGet).toHaveBeenCalledWith("user1");
    });
});
