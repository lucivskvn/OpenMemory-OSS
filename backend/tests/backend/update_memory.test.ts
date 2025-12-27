import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { add_hsg_memory, update_memory } from "../../src/memory/hsg";
import { q } from "../../src/core/db";
import { env } from "../../src/core/cfg";

describe("update_memory behavior", () => {
    beforeAll(() => {
        // Force synthetic embeddings and fast tier for deterministic, fast tests
        (env as any).emb_kind = "synthetic";
        (env as any).embed_mode = "simple";
        (env as any).vec_dim = 256;
    });

    afterAll(() => {
        // No-op: restore if needed
    });

    it("updates mean vector and content correctly", async () => {
        const id = `upd_${Date.now()}`;
        const r = await add_hsg_memory("original content for update test", "[]", {}, "updater");
        const mem_before = await q.get_mem.get(r.id);
        const newText = "updated content with new semantics";
        await update_memory(r.id, newText, undefined, undefined);
        const mem_after = await q.get_mem.get(r.id);
        expect(mem_after.content).toBe(newText);
        expect(mem_after.mean_dim).toBeGreaterThan(0);
        expect(mem_after.mean_vec).not.toBeNull();
    });
});