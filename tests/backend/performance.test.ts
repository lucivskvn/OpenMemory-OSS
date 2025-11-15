import { describe, it, expect } from "bun:test";
import { fuse_vecs, gen_syn_emb, emb_dim } from "../../backend/src/memory/embed";

function vecNorm(v: number[]) {
    return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

describe("embedding utilities performance and correctness", () => {
    it("fuse_vecs returns correctly-sized, normalized vector", () => {
        const dim = emb_dim();
        const syn = Array(dim).fill(1);
        const sem = Array(Math.floor(dim / 2)).fill(0.5);
        const f = fuse_vecs(syn, sem);
        expect(f.length).toBe(syn.length + sem.length);
        const n = vecNorm(f);
        // Should be normalized (or close)
        expect(n).toBeGreaterThan(0.9);
        expect(n).toBeLessThan(1.1);
    });

    if (process.env.OM_RUN_PERF_TESTS === 'true') {
        it("gen_syn_emb is reasonably fast for small inputs", () => {
            const t = "This is a short test string to measure synthetic embedding performance.";
            const runs = 200;
            const start = Date.now();
            for (let i = 0; i < runs; i++) gen_syn_emb(t, "semantic");
            const elapsed = Date.now() - start;
            // Expect under 2s for 200 runs when perf tests are enabled
            expect(elapsed).toBeLessThan(2000);
        });
    } else {
        it("gen_syn_emb perf test skipped (OM_RUN_PERF_TESTS != 'true')", () => {
            // Perf tests are gated behind OM_RUN_PERF_TESTS to avoid CI flakiness.
        });
    }
});
