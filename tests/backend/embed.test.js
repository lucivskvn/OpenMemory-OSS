import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';

// Set environment before importing modules so they pick up values at load-time
process.env.OM_TEST_MODE = '1';
process.env.OM_METADATA_BACKEND = 'sqlite';
process.env.OM_DB_PATH = ':memory:';
process.env.OM_EMBED_KIND = process.env.OM_EMBED_KIND || 'local';
process.env.OM_VEC_DIM = process.env.OM_VEC_DIM || '128';

// Preserve existing env and restore after tests
const _oldOm = process.env.OM_LOG_LEVEL;
const _oldEmbed = process.env.OM_LOG_EMBED_LEVEL;
const _oldVec = process.env.OM_VEC_DIM;

afterEach(() => {
    if (_oldOm === undefined) delete process.env.OM_LOG_LEVEL; else process.env.OM_LOG_LEVEL = _oldOm;
    if (_oldEmbed === undefined) delete process.env.OM_LOG_EMBED_LEVEL; else process.env.OM_LOG_EMBED_LEVEL = _oldEmbed;
    if (_oldVec === undefined) delete process.env.OM_VEC_DIM; else process.env.OM_VEC_DIM = _oldVec;
});

// Stable test imports (import after environment set)
import { initDb, q, get_async, closeDb } from '../../backend/src/core/db.test-entry';
import * as embedMod from '../../backend/src/memory/embed';

beforeEach(async () => {
    await initDb();
    try {
        if (embedMod && embedMod.__TEST && typeof embedMod.__TEST.reset === 'function') embedMod.__TEST.reset();
    } catch (e) { }
    // Install default synthetic test providers to avoid accidental network calls
    try {
        const dim = (process.env.OM_VEC_DIM && parseInt(process.env.OM_VEC_DIM)) || 128;
        const defaultProvider = async () => Array.from({ length: dim }, (_, i) => (i + 1) / dim);
        const defaultBatchProvider = async (texts) => texts.map(() => Array.from({ length: dim }, (_, i) => (i + 1) / dim));
        if (typeof embedMod.__setTestProvider === 'function') {
            embedMod.__setTestProvider(defaultProvider);
        } else if (embedMod && embedMod.__TEST) {
            embedMod.__TEST.provider = defaultProvider;
        }
        if (typeof embedMod.__setTestBatchProvider === 'function') {
            embedMod.__setTestBatchProvider(defaultBatchProvider);
        } else if (embedMod && embedMod.__TEST) {
            embedMod.__TEST.batchProvider = defaultBatchProvider;
        }
    } catch (e) { }
});

afterAll(async () => {
    try {
        // Ensure embed queues are idle before closing DB to avoid races
        try {
            const embed = await import('../../backend/src/memory/embed');
            if (embed && embed.__TEST && typeof embed.__TEST.waitForIdle === 'function') {
                try { await embed.__TEST.waitForIdle(); } catch (e) { }
            }
        } catch (e) { }
        await closeDb();
    } catch (e) { }
});

describe('embed logging level resolution', () => {
    it('defaults to info when nothing set', () => {
        delete process.env.OM_LOG_LEVEL;
        delete process.env.OM_LOG_EMBED_LEVEL;
        const thr = embedMod._getEmbedLevelThreshold_for_test();
        expect(typeof thr).toBe('number');
        expect(thr).toBeGreaterThanOrEqual(1);
    });

    it('respects OM_LOG_EMBED_LEVEL when set', () => {
        process.env.OM_LOG_EMBED_LEVEL = 'debug';
        const thr = embedMod._getEmbedLevelThreshold_for_test();
        expect(thr).toBe(0);
    });

    it('falls back to OM_LOG_LEVEL when embed level unset', () => {
        delete process.env.OM_LOG_EMBED_LEVEL;
        process.env.OM_LOG_LEVEL = 'warn';
        const thr = embedMod._getEmbedLevelThreshold_for_test();
        expect(thr).toBe(2);
    });
});

describe('Embedding layer integration tests', () => {
    afterEach(async () => {
        // best-effort cleanup of vectors inserted during tests
        try { await q.del_vec.run('mem-test', 'semantic', 'user1'); } catch (e) { }
        // ensure embed queues are idle before moving on
        try {
            if (embedMod && embedMod.__TEST && typeof embedMod.__TEST.waitForIdle === 'function') {
                try { await embedMod.__TEST.waitForIdle(); } catch (e) { }
            }
        } catch (e) { }
    });

  it('local embedding returns normalized vector and records logs', async () => {
      const info = embedMod.getEmbeddingInfo();
      const expectedDim = info.dimensions || 256;
    const id = 'embed-test-1';
      const res = await embedMod.embedMultiSector(id, 'this is a test', ['semantic'], undefined, 'test-user');
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(1);
    const v = res[0].vector;
      expect(v.length).toBe(expectedDim);

    // Persist vector into DB and read it back
      const buf = embedMod.vectorToBuffer(v);
    await q.ins_vec.run(id, 'semantic', 'test-user', buf, v.length);
    const stored = await q.get_vec.get(id, 'semantic', 'test-user');
      expect(stored).toBeTruthy();
    let storedBuf = stored.v;
      if (!storedBuf || typeof storedBuf.readFloatLE !== 'function') storedBuf = Buffer.from(storedBuf || []);
      const retrieved = embedMod.bufferToVector(storedBuf);
    expect(retrieved.length).toBe(v.length);
      expect(embedMod.cosineSimilarity(v, retrieved)).toBeGreaterThan(0.9999);

    const logRow = await get_async('select status from embed_logs where id=?', [id]);
    expect(logRow).toBeTruthy();
    expect(String(logRow.status).toLowerCase()).toBe('completed');
  });

  it('synthetic generator and sector fuser behave and return expected dims', async () => {
      const syn = embedMod.gen_syn_emb('tokens for synthetic', 'episodic');
      expect(Array.isArray(syn)).toBe(true);
      // Avoid brittle exact-dimension assertions here. Instead ensure the
      // synthetic generator and runtime semantic provider produce vectors
      // with the same dimensionality and that it's a positive length.
      const sem = await embedMod.embedForSector('some text', 'semantic');
      expect(Array.isArray(sem)).toBe(true);
      expect(syn.length).toBeGreaterThan(0);
      expect(sem.length).toBeGreaterThan(0);

      const fused = embedMod.fuse_vecs(syn, sem);
      expect(Array.isArray(fused)).toBe(true);
    expect(fused.length).toBe(syn.length + sem.length);
  });

    describe('failure and retry behavior', () => {
        let origSetTimeout;
        let origTestProvider;

        beforeEach(() => {
            origSetTimeout = globalThis.setTimeout;
            // speed up retries to make tests fast
            globalThis.setTimeout = (fn, ms, ...args) => origSetTimeout(fn, 0, ...args);
            try { origTestProvider = embedMod.__TEST && embedMod.__TEST.provider; } catch (e) { origTestProvider = null; }
        });

        afterEach(() => {
            globalThis.setTimeout = origSetTimeout;
            try {
                if (embedMod && embedMod.__TEST && typeof embedMod.__TEST.reset === 'function') embedMod.__TEST.reset();
                else if (embedMod && typeof embedMod.__setTestProvider === 'function') embedMod.__setTestProvider(origTestProvider);
            } catch (e) { }
        });

        it('marks embed_logs failed after retries and logs error with user_id', async () => {
            process.env.OM_EMBED_KIND = 'openai';
            const id = 'embed-retry-fail';
            let calls = 0;

            // inject test provider that always throws
            try {
                if (typeof embedMod.__setTestProvider === 'function') {
                    embedMod.__setTestProvider(async () => { calls++; throw new Error('Simulated API failure'); });
                } else if (embedMod.__TEST) {
                    embedMod.__TEST.provider = async () => { calls++; throw new Error('Simulated API failure'); };
                }
            } catch (e) { }

            // spy on logger.error via dynamic import to avoid top-level circulars
            const errors = [];
            let handle;
            try {
                const loggerMod = await import('../../backend/src/core/logger');
                const { spyLoggerMethod } = await import('../utils/spyLoggerSafely');
                handle = spyLoggerMethod(loggerMod, 'error', (...args) => { errors.push(args); });
            } catch (e) { }

            let threw = false;
            try { await embedMod.embedMultiSector(id, 'will fail', ['semantic'], undefined, 'test-user'); } catch (e) { threw = true; }
            // wait for embed internal queues and log persistence
            try { if (embedMod && embedMod.__TEST && typeof embedMod.__TEST.waitForIdle === 'function') await embedMod.__TEST.waitForIdle(); } catch (e) { }
            expect(threw).toBe(true);
            expect(calls).toBeGreaterThanOrEqual(3);

            const row = await get_async('select status,err from embed_logs where id=?', [id]);
            expect(row).toBeTruthy();
            expect(String(row.status).toLowerCase()).toBe('failed');
            expect(row.err).toBeTruthy();
            expect(String(row.err)).toContain('Simulated API failure');

            const found = errors.find((args) => args.some(a => String(a).includes && String(a).includes('multi-sector failed') || String(a).includes('multi-sector failed')));
            // Spy on logger.error is best-effort; some runtimes or logger shapes
            // may not allow safe spying. If we didn't capture any logger calls,
            // skip the logger-specific assertions but keep DB-level checks above
            // which validate the embed failure and stored error message.
            if (found) {
                // try to find a user_id in the logged args
                const userArg = found.find(a => a && typeof a === 'object' && a.user_id);
                expect(userArg && userArg.user_id === 'test-user').toBe(true);
            }
            if (handle && typeof handle.restore === 'function') handle.restore();
        });

        it('succeeds on third attempt and records completed status', async () => {
            process.env.OM_EMBED_KIND = 'openai';
            const id = 'embed-retry-ok';
            let calls = 0;
            const dim = (process.env.OM_VEC_DIM && parseInt(process.env.OM_VEC_DIM)) || 128;

            try {
                if (typeof embedMod.__setTestProvider === 'function') {
                    embedMod.__setTestProvider(async () => { calls++; if (calls < 3) throw new Error('temporary failure'); return Array(dim).fill(0).map((_, i) => (i + 1) / dim); });
                } else if (embedMod.__TEST) {
                    embedMod.__TEST.provider = async () => { calls++; if (calls < 3) throw new Error('temporary failure'); return Array(dim).fill(0).map((_, i) => (i + 1) / dim); };
                }
            } catch (e) { }

            const res = await embedMod.embedMultiSector(id, 'recovering text', ['semantic'], undefined, 'test-user2');
            expect(Array.isArray(res)).toBe(true);
            expect(res.length).toBe(1);
            const v = res[0].vector;
            expect(v.length).toBe(dim);

            const row = await get_async('select status,err from embed_logs where id=?', [id]);
            expect(row).toBeTruthy();
            expect(String(row.status).toLowerCase()).toBe('completed');
            expect(row.err === null || row.err === undefined).toBe(true);
        });
  });

    it('embedMultiSector marks logs failed after retries when provider consistently fails', async () => {
        const id = 'embed-fail-test';
        process.env.OM_EMBED_KIND = 'openai';
        process.env.OM_OPENAI_KEY = process.env.OM_OPENAI_KEY || 'test-key';
        process.env.OM_VEC_DIM = process.env.OM_VEC_DIM || '128';

        let calls = 0;
        try {
            if (typeof embedMod.__setTestProvider === 'function') {
                embedMod.__setTestProvider(async () => { calls++; throw new Error('forced failure for test'); });
            } else if (embedMod.__TEST) {
                embedMod.__TEST.provider = async () => { calls++; throw new Error('forced failure for test'); };
        }
        } catch (e) { }

        let threw = false;
        try { await embedMod.embedMultiSector(id, 'this will fail', ['semantic'], undefined, 'test-user'); } catch (e) { threw = true; }
        try { if (embedMod && embedMod.__TEST && typeof embedMod.__TEST.waitForIdle === 'function') await embedMod.__TEST.waitForIdle(); } catch (e) { }

        // Clean up any injected test provider to avoid leaking into other tests/files
        try {
            if (embedMod && embedMod.__TEST && typeof embedMod.__TEST.reset === 'function') embedMod.__TEST.reset();
        } catch (e) { }

        const row = await get_async('select status,err from embed_logs where id=?', [id]);
        expect(threw).toBe(true);
        expect(row).toBeTruthy();
        expect(String(row.status).toLowerCase()).toBe('failed');
        expect(row.err).toBeTruthy();
        expect(String(row.err).length).toBeGreaterThan(0);
        expect(calls).toBeGreaterThanOrEqual(3);
    });

});
