import { describe, it, expect, beforeAll } from "bun:test";
import { q } from "../../src/core/db";
import { run_reflection } from "../../src/memory/reflect";
import { env } from "../../src/core/cfg";

describe("Reflection job", () => {
    const user = `reflect_user_${Date.now()}`;
    beforeAll(async () => {
        // Ensure reflect_min is small for test and force synthetic embeddings for speed
        (env as any).reflect_min = 2;
        (env as any).emb_kind = "synthetic";
        (env as any).embed_mode = "simple";
        (env as any).vec_dim = 256;
        const now = Date.now();
        // Insert 3 similar memories for the user with the same simhash
        const sh = "ffffffffffffffff";
        await q.ins_mem.run(`m1_${user}`, user, 0, "First observation", sh, "semantic", "[]", "{}", now, now, now, 0.5, 0.0, 1, null, null, null, 0);
        await q.ins_mem.run(`m2_${user}`, user, 0, "Second observation", sh, "semantic", "[]", "{}", now, now, now, 0.6, 0.0, 1, null, null, null, 0);
        await q.ins_mem.run(`m3_${user}`, user, 0, "Third observation", sh, "semantic", "[]", "{}", now, now, now, 0.4, 0.0, 1, null, null, null, 0);
    });

    it("creates a reflection memory for the user and marks sources consolidated", async () => {
        const res = await run_reflection();
        expect(res.created).toBeGreaterThanOrEqual(1);
        // Check reflections exist for this user
        const refls = await q.search_mem_by_tag_user.all("%reflect:auto%", user, 10, 0);
        expect(refls.length).toBeGreaterThanOrEqual(1);

        // Ensure source memories are marked consolidated
        const m1 = await q.get_mem.get(`m1_${user}`);
        expect(JSON.parse(m1.meta || "{}").consolidated).toBe(true);
    });
});