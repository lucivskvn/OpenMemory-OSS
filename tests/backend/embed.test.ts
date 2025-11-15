import { test, expect, beforeEach, afterEach, describe, it } from 'bun:test';

// Set env before importing the embed module so cfg picks it up
process.env.OM_DB_PATH = ':memory:';
process.env.OM_METADATA_BACKEND = 'sqlite';
process.env.OM_EMBED_KIND = 'local';
process.env.OM_VEC_DIM = '32';
process.env.OM_EMBED_MODE = 'advanced';

import { embedMultiSector, vectorToBuffer, getEmbeddingInfo, fuse_vecs, __TEST } from '../../backend/src/memory/embed';
import { initDb, q, all_async, get_async, closeDb } from '../../backend/src/core/db.test-entry';
import logger from '../../backend/src/core/logger';
import { env } from '../../backend/src/core/cfg';

beforeEach(async () => {
    await initDb();
});

afterEach(async () => {
    try {
        await q.del_vec.run('mem-test', 'semantic', 'user1');
    } catch (e) { }
    try {
        // Wait for any internal embed queues to finish before closing DB to
        // avoid "Cannot use a closed database" races when embed background
        // tasks (e.g. gem_q) are still completing.
        try {
            if (__TEST && typeof __TEST.waitForIdle === 'function') await __TEST.waitForIdle();
        } catch (e) { }
        await closeDb();
    } catch (e) { }
});

test('embeds sectors with user_id present and logs user context', async () => {
    // Spy on logger.info to capture the user_id being logged
    let handleInfo: any = null;
    let seen: any = null;
    try {
        const { spyLoggerMethod } = await import('../utils/spyLoggerSafely');
        handleInfo = spyLoggerMethod(logger, 'info', (meta: any, msg?: any) => {
            try { if (meta && meta.user_id) seen = meta.user_id; } catch (e) { }
        });
    } catch (e) { /* ignore, spyLoggerMethod is tolerant */ }

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
    try { if (handleInfo && typeof handleInfo.restore === 'function') handleInfo.restore(); } catch (e) { }
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
    // Use runtime embedding info (getEmbeddingInfo) which reflects current
    // `process.env` values even if `core/cfg` was parsed earlier by other
    // tests. fall back to 256 if unavailable.
    const dim = embedMod.getEmbeddingInfo().dimensions || 256;

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
    // Compare against runtime-reported dimensions so tests remain stable
    // when `core/cfg` was imported earlier by another test file.
    expect(out[0].dim).toBe(getEmbeddingInfo().dimensions);

    // Verify logs: the embed function should have updated the log entry to completed (no pending)
    const pending = await q.get_pending_logs.all();
    const failed = await q.get_failed_logs.all();
    expect(pending.find((r: any) => r.id === id)).toBeUndefined();
    expect(failed.find((r: any) => r.id === id)).toBeUndefined();
});

describe('embedLog threshold enforcement', () => {
    const origEnv = { ...process.env };
    afterEach(() => {
        // restore env after each
        process.env = { ...origEnv };
    });

    it('suppresses debug/info logs when OM_LOG_EMBED_LEVEL=warn', async () => {
        process.env.OM_EMBED_KIND = 'local';
        // Ensure local provider path is present so emb_local does not emit warn-level fallback
        process.env.OM_LOCAL_MODEL_PATH = 'present';
        process.env.OM_LOG_EMBED_LEVEL = 'warn';

        const loggerMod: any = await import('../../backend/src/core/logger');
        const embedMod: any = await import('../../backend/src/memory/embed');

        // Spy by capturing calls and ensure none are from EMBED component
        const calls: any[] = [];
        let handleInfo2: any = null;
        let handleDebug2: any = null;
        try {
            const { spyLoggerMethod } = await import('../utils/spyLoggerSafely');
            handleInfo2 = spyLoggerMethod(loggerMod, 'info', (meta: any, msg?: any) => { calls.push({ level: 'info', meta, msg }); });
            handleDebug2 = spyLoggerMethod(loggerMod, 'debug', (meta: any, msg?: any) => { calls.push({ level: 'debug', meta, msg }); });
        } catch (_) { }
        const origWarn = loggerMod.default.warn;

        try {
            const out = await embedMod.embedMultiSector('log-suppress-test', 'test text', ['semantic'], undefined, 'test-user');
            expect(Array.isArray(out)).toBe(true);
            // Ensure no info/debug calls originated from the EMBED component
            const embedCalls = calls.filter((c) => {
                try {
                    return (c.meta && c.meta.component === 'EMBED') || (typeof c.msg === 'string' && c.msg.includes('[EMBED]'));
                } catch (e) { return false; }
            });
            expect(embedCalls.length).toBe(0);
        } finally {
            try { if (handleInfo2 && typeof handleInfo2.restore === 'function') handleInfo2.restore(); } catch (_) { }
            try { if (handleDebug2 && typeof handleDebug2.restore === 'function') handleDebug2.restore(); } catch (_) { }
            try { if (origWarn) loggerMod.default.warn = origWarn; } catch (_) { }
            delete process.env.OM_LOG_EMBED_LEVEL;
        }
    });

    it('emits debug/info logs when OM_LOG_EMBED_LEVEL=debug', async () => {
        process.env.OM_EMBED_KIND = 'local';
        process.env.OM_LOCAL_MODEL_PATH = 'present';
        process.env.OM_LOG_EMBED_LEVEL = 'debug';

        const loggerMod: any = await import('../../backend/src/core/logger');
        const embedMod: any = await import('../../backend/src/memory/embed');

        const calls: any[] = [];
        let handleInfo3: any = null;
        let handleDebug3: any = null;
        try {
            const { spyLoggerMethod } = await import('../utils/spyLoggerSafely');
            handleInfo3 = spyLoggerMethod(loggerMod, 'info', (meta: any, msg?: any) => { calls.push({ level: 'info', meta, msg }); });
            handleDebug3 = spyLoggerMethod(loggerMod, 'debug', (meta: any, msg?: any) => { calls.push({ level: 'debug', meta, msg }); });
        } catch (_) { }

        try {
            const out = await embedMod.embedMultiSector('log-emit-test', 'test debug text', ['semantic'], undefined, 'test-user-debug');
            expect(Array.isArray(out)).toBe(true);
            // At least one info or debug call should have occurred from EMBED component
            const embedCalls = calls.filter((c) => {
                try {
                    return (c.meta && c.meta.component === 'EMBED') || (typeof c.msg === 'string' && c.msg.includes('[EMBED]'));
                } catch (e) { return false; }
            });
            expect(embedCalls.length).toBeGreaterThanOrEqual(1);
            // Inspect that at least one call included the user_id metadata
            const withUser = embedCalls.find((c) => c.meta && c.meta.user_id === 'test-user-debug');
            expect(withUser).toBeTruthy();
        } finally {
            try { if (handleInfo3 && typeof handleInfo3.restore === 'function') handleInfo3.restore(); } catch (_) { }
            try { if (handleDebug3 && typeof handleDebug3.restore === 'function') handleDebug3.restore(); } catch (_) { }
            delete process.env.OM_LOG_EMBED_LEVEL;
        }
    });
});

test('provider failure triggers gemini fallback to synthetic', async () => {
    // Make the provider gemini which contains internal retry+fallback logic
    process.env.OM_EMBED_KIND = 'gemini';
    // force small dims for speed
    const _oldVec = process.env.OM_VEC_DIM;
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
        if (_oldVec === undefined) delete process.env.OM_VEC_DIM; else process.env.OM_VEC_DIM = _oldVec;
    }
});
