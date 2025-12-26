import { describe, expect, it, beforeAll } from "bun:test";
import { q, run_async } from "../../src/core/db";
import { now } from "../../src/utils";

describe("Reflection Optimization", () => {
    const id = "reflect_test_" + Date.now();

    beforeAll(async () => {
        await q.ins_mem.run(id, "user_ref", 0, "Test content", "hash", "semantic", "[]", "{}", now(), now(), now(), 1, 0.1, 1, null, null, null, 0);
    });

    it("should update metadata without changing content", async () => {
        const meta = { consolidated: true, extra: "value" };
        await q.upd_meta.run(JSON.stringify(meta), now(), id);

        const m = await q.get_mem.get(id);
        expect(JSON.parse(m.meta)).toEqual(meta);
        expect(m.content).toBe("Test content"); // Content unchanged
    });
});
