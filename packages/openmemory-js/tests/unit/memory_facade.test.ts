
import { describe, expect, test, jest, beforeEach, mock } from "bun:test";
import { Memory } from "../../src/core/memory";
import * as t_store from "../../src/temporal_graph/store";

// Mock temporal store
mock.module("../../src/temporal_graph/store", () => ({
    insertFact: jest.fn(),
    getCurrentFact: jest.fn(),
    updateFact: jest.fn(),
    invalidateFact: jest.fn(),
    insertEdge: jest.fn(),
    updateEdge: jest.fn(),
    invalidateEdge: jest.fn(),
}));

describe("Memory Facade - Temporal Parity", () => {
    let mem: Memory;
    const userId = "user-123";

    beforeEach(() => {
        mem = new Memory(userId);
        jest.clearAllMocks();
    });

    test("temporal.updateEdge passes arguments correctly", async () => {
        const edgeId = "edge-uuid";
        const weight = 0.8;
        const metadata = { note: "test" };

        await mem.temporal.updateEdge(edgeId, weight, metadata);

        expect(t_store.updateEdge).toHaveBeenCalledWith(
            edgeId,
            { weight, metadata },
            userId // defaultUserId normalized
        );
    });

    test("temporal.updateEdge handles missing metadata", async () => {
        const edgeId = "edge-uuid-2";
        await mem.temporal.updateEdge(edgeId, 0.5);

        expect(t_store.updateEdge).toHaveBeenCalledWith(
            edgeId,
            { weight: 0.5, metadata: undefined },
            userId
        );
    });
});
