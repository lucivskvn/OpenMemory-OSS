import { test, expect, beforeEach, afterEach } from 'bun:test';

// Set env before importing the embed module so cfg picks it up
process.env.OM_DB_PATH = ':memory:';
process.env.OM_METADATA_BACKEND = 'sqlite';
process.env.OM_EMBED_KIND = 'local';
process.env.OM_VEC_DIM = '32';
process.env.OM_EMBED_MODE = 'advanced';

import { embedMultiSector, vectorToBuffer, getEmbeddingInfo, fuse_vecs } from '../../backend/src/memory/embed.js';
import { initDb, q, all_async, get_async } from '../../backend/src/core/db.js';
import logger from '../../backend/src/core/logger.js';
import { env } from '../../backend/src/core/cfg.js';

beforeEach(async () => {
    await initDb();
});

afterEach(async () => {
    try {
        await q.del_vec.run('mem-test', 'semantic', 'user1');
    } catch (e) { }
});

test('embeds sectors with user_id present and logs user context', async () => {
    // Spy on logger.info to capture the user_id being logged
    const origInfo = logger.info;
    let seen: any = null;
    (logger as any).info = (meta: any, msg?: any) => {
        try {
            if (meta && meta.user_id) seen = meta.user_id;
        } catch (e) { }
        try {
            return origInfo(meta, msg);
        } catch (e) { }
    };

    const res = await embedMultiSector('e1', 'Hello OpenMemory', ['semantic', 'episodic'], undefined, 'user1');
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(2);
    expect(seen).toBe('user1');

    // verify vector dims are consistent with returned vector length
    for (const r of res) {
        expect(r.dim).toBeGreaterThan(0);
        expect(r.dim).toBe(r.vector.length);
    }

    // Insert returned vector for user1 and assert tenant-scoped query
    const buf = vectorToBuffer(res[0].vector);
    await q.ins_vec.run('mem-test', res[0].sector, 'user1', buf, res[0].dim);
    const sUser1 = await q.get_vecs_by_sector.all(res[0].sector, 'user1');
    expect(sUser1.length).toBeGreaterThanOrEqual(1);
    const sOther = await q.get_vecs_by_sector.all(res[0].sector, 'other-user');
    expect(sOther.length).toBe(0);

    // restore logger
    (logger as any).info = origInfo;
});
test('embed provider info - returns provider metadata', () => {
    const info = getEmbeddingInfo();
    expect(info).toHaveProperty('provider');
    expect(info).toHaveProperty('dimensions');
    expect(typeof info.dimensions).toBe('number');
    });

test('embedMultiSector returns per-sector vectors and fuse_vecs normalizes', async () => {
    // Force synthetic embeddings for offline tests
    process.env.OM_EMBED_KIND = 'synthetic';
    const embedMod: any = await import('../../backend/src/memory/embed');
    const cfgMod: any = await import('../../backend/src/core/cfg');
    const dim = cfgMod.env.vec_dim || 256;

    const secs = ['semantic', 'episodic'];
    // Explicitly pass null user_id to indicate this test is intentionally unscoped
    const out = await embedMod.embedMultiSector('test-embed-id', 'hello world embed test', secs, undefined, null);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(secs.length);
    for (const r of out) {
        expect(r.dim || r['dim']).toBe(dim);
        expect(Array.isArray(r.vector)).toBe(true);
        expect(r.vector.length).toBe(dim);
    }

    const syn = Array(dim).fill(0.5);
    const sem = Array(dim).fill(0.2);
    const fused = fuse_vecs(syn, sem);
    expect(fused.length).toBe(syn.length + sem.length);
    const norm = Math.sqrt(fused.reduce((s: number, v: number) => s + v * v, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
});

test('embedMultiSector records logs and respects user_id', async () => {
    // Use an ephemeral in-memory DB for log assertions
    process.env.OM_DB_PATH = ':memory:';
    process.env.OM_METADATA_BACKEND = 'sqlite';
    await initDb();

    const embedMod: any = await import('../../backend/src/memory/embed');
    process.env.OM_EMBED_KIND = 'synthetic';
    const id = `embed-log-${Date.now()}`;
    const secs = ['semantic'];
    const userId = 'test-embed-user';

    const out = await embedMod.embedMultiSector(id, 'some text to embed', secs, undefined, userId);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].dim).toBe(env.vec_dim);

    // Verify logs: the embed function should have updated the log entry to completed (no pending)
    const pending = await q.get_pending_logs.all();
    const failed = await q.get_failed_logs.all();
    expect(pending.find((r: any) => r.id === id)).toBeUndefined();
    expect(failed.find((r: any) => r.id === id)).toBeUndefined();
});

test('provider failure triggers gemini fallback to synthetic', async () => {
    // Make the provider gemini which contains internal retry+fallback logic
    process.env.OM_EMBED_KIND = 'gemini';
    // force small dims for speed
    process.env.OM_VEC_DIM = '16';
    // mock fetch to always throw
    const origFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
        throw new Error('network failure');
    };
    try {
        // dynamic import after env changes so module picks up new cfg
        const embedMod: any = await import('../../backend/src/memory/embed');
        const out = await embedMod.embedMultiSector('fail-embed', 'some text', ['semantic'], undefined, 'user-fail');
        expect(Array.isArray(out)).toBe(true);
        expect(out.length).toBe(1);
        const dim = embedMod.getEmbeddingInfo().dimensions || Number(process.env.OM_VEC_DIM);
        expect(out[0].vector.length).toBe(dim);
    } finally {
        (globalThis as any).fetch = origFetch;
    }
});
