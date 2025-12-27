import { describe, it, expect } from "bun:test";
import { gen_syn_emb, compress_vec, fuse_vecs } from "../../src/memory/embed";

// Verify fusion logic for smart tier creates fused vector length = syn + compressed
describe("embed smart fusion", () => {
    it("fuses semantic and compressed vectors producing expected dimension", () => {
        const text = "Hello world this is a test for smart fusion";
        const syn = gen_syn_emb(text, "semantic");
        const sem = gen_syn_emb(text, "semantic");
        const comp = compress_vec(sem, 128);
        const fused = fuse_vecs(syn as any, comp as any);
        expect(fused.length).toBe(syn.length + 128);
    });
});
