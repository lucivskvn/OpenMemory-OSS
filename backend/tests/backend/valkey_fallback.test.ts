import { describe, it, expect } from "bun:test";
import { ValkeyVectorStore } from "../../src/core/vector/valkey";
import { vectorToBuffer } from "../../src/memory/embed";

describe("Valkey fallback behavior", () => {
    it("falls back to scan when FT.SEARCH is unavailable and returns correct similarity order", async () => {
        // Prepare fake entries
        const entries: Record<string, any> = {};
        const k1 = "vec:semantic:1";
        const k2 = "vec:semantic:2";
        entries[k1] = { v: vectorToBuffer([1, 0]).toString("latin1"), dim: "2", user_id: "u1" };
        entries[k2] = { v: vectorToBuffer([0.9, 0.1]).toString("latin1"), dim: "2", user_id: "u1" };

        const fakeClient = {
            send: async () => { throw new Error("FT.INFO missing"); },
            scan: async (_cursor: string, _a?: any, _b?: any, _c?: any, _d?: any) => {
                return ["0", Object.keys(entries)];
            },
            hget: async (key: string, field: string) => {
                const e = entries[key];
                if (!e) return null;
                if (field === "v") return e.v;
                if (field === "dim") return e.dim;
                return null;
            },
            hmget: async (key: string, fields: string[]) => {
                const e = entries[key];
                if (!e) return [null, null];
                return [e.v, e.dim, e.user_id];
            }
        } as any;

        const store = new ValkeyVectorStore(fakeClient as any);
        const res = await store.searchSimilar("semantic", [1, 0], 2, "u1");
        expect(res.length).toBe(2);
        // Expect the exact match to be first
        expect(res[0].id).toBe("1");
    });
});
