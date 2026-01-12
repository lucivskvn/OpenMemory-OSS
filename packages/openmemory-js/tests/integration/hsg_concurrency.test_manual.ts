import { describe, expect, test, beforeEach, mock } from "bun:test";

mock.module("../../src/core/db", () => ({
    q: {
        insMem: { run: mock(async () => 1) },
        delMem: { run: mock(async () => 1) },
        getMem: { get: mock(async () => undefined) },
        getMemBySimhash: { get: mock(async () => undefined) },
    },
    vectorStore: {
        storeVector: mock(async () => { }),
        deleteVectors: mock(async () => { }),
    },
    transaction: {
        run: mock(async (fn: any) => fn()),
    },
    closeDb: async () => { },
}));

mock.module("../../src/core/security", () => ({
    getEncryption: () => ({
        encrypt: async (t: string) => t,
        decrypt: async (t: string) => t,
    })
}));

mock.module("../../src/memory/embed", () => ({
    embedMultiSector: async () => [{ sector: "semantic", vector: [0.1, 0.2], dim: 2 }],
}));

import { addMemory } from "../../src/memory/hsg";
import * as db from "../../src/core/db";

describe("HSG Transaction Safety (Isolated)", () => {

    beforeEach(() => {
        (db.q.insMem.run as any).mockClear();
        (db.vectorStore.storeVector as any).mockClear();
    });

    test("addMemory succeeds when all systems work", async () => {
        const res = await addMemory("test content", "user1", {});
        expect(res.id).toBeDefined();
        expect(db.q.insMem.run).toHaveBeenCalledTimes(1);
        expect(db.vectorStore.storeVector).toHaveBeenCalledTimes(1);
    }, 10000);

    test("addMemory rolls back logic path if vector store fails", async () => {
        (db.vectorStore.storeVector as any).mockImplementationOnce(async () => { throw new Error("Vector DB Down"); });

        try {
            await addMemory("test rollback", "user1", {});
            expect.unreachable("Should have thrown");
        } catch (e: any) {
            expect(e.message).toContain("Vector DB Down");
        }

        expect(db.q.insMem.run).toHaveBeenCalledTimes(1);
        expect(db.vectorStore.storeVector).toHaveBeenCalledTimes(1);
    }, 10000);
});
