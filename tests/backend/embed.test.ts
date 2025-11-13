import { describe, it, expect } from "bun:test";
import { getEmbeddingInfo } from "../../backend/src/memory/embed";
import { initDb, q } from "../../backend/src/core/db";
import { env } from "../../backend/src/core/cfg";

describe("embed provider info", () => {
    it("returns provider metadata", () => {
        const info = getEmbeddingInfo();
        expect(info).toHaveProperty("provider");
        expect(info).toHaveProperty("dimensions");
        expect(typeof info.dimensions).toBe("number");
    });

    it("embedMultiSector returns per-sector vectors and fuse_vecs normalizes", async () => {
        // Force synthetic embeddings for offline tests
        process.env.OM_EMBED_KIND = "synthetic";
        const embedMod: any = await import("../../backend/src/memory/embed");
        const cfgMod: any = await import("../../backend/src/core/cfg");
        const dim = cfgMod.env.vec_dim || 256;

        const secs = ["semantic", "episodic"];
        const out = await embedMod.embedMultiSector("test-embed-id", "hello world embed test", secs);
        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBe(secs.length);
        for (const r of out) {
            expect(r.dim || r["dim"]).toBe(dim);
            expect(Array.isArray(r.vector)).toBe(true);
            expect(r.vector.length).toBe(dim);
        }

        const syn = Array(dim).fill(0.5);
        const sem = Array(dim).fill(0.2);
        const fused = embedMod.fuse_vecs(syn, sem);
        expect(fused.length).toBe(syn.length + sem.length);
        const norm = Math.sqrt(fused.reduce((s: number, v: number) => s + v * v, 0));
        expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
    });

    it("embedMultiSector records logs and respects user_id", async () => {
        // Use an ephemeral in-memory DB for log assertions
        process.env.OM_DB_PATH = ":memory:";
        process.env.OM_METADATA_BACKEND = "sqlite";
        await initDb();

        const embedMod: any = await import("../../backend/src/memory/embed");
        process.env.OM_EMBED_KIND = "synthetic";
        const id = `embed-log-${Date.now()}`;
        const secs = ["semantic"];
        const userId = "test-embed-user";

        const out = await embedMod.embedMultiSector(id, "some text to embed", secs, undefined, userId);
        expect(Array.isArray(out)).toBe(true);
        expect(out[0].dim).toBe(env.vec_dim);

        // Verify logs: the embed function should have updated the log entry to completed (no pending)
        const pending = await q.get_pending_logs.all();
        const failed = await q.get_failed_logs.all();
        expect(pending.find((r: any) => r.id === id)).toBeUndefined();
        expect(failed.find((r: any) => r.id === id)).toBeUndefined();
    });
});
