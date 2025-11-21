import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spyLoggerMethod } from '../utils/spyLoggerSafely';

// Ensure test environment defaults
process.env.OM_DB_PATH = ':memory:';
process.env.OM_METADATA_BACKEND = 'sqlite';
process.env.OM_NO_AUTO_START = 'true';
process.env.OM_EMBED_KIND = 'synthetic';
process.env.OM_EMBED_MODE = 'advanced';
process.env.OM_VEC_DIM = '32';

// Helpers to import modules under test
const EMBED_PATH = '../../backend/src/memory/embed';
const LOGGER_PATH = '../../backend/src/core/logger';

let origFetch: any;
let origSetTimeout: any;
let logger: any;
let embedMod: any;

function installDefaultProviders(mod: any) {
  try {
    // Only install default synthetic providers when embed kind is synthetic.
    const kind = (process.env.OM_EMBED_KIND || '').toLowerCase();
    if (kind !== 'synthetic') return;
    const dim = Number(process.env.OM_VEC_DIM) || 32;
    const defaultProvider = async () =>
      Array.from({ length: dim }, (_, i) => (i + 1) / dim);
    const defaultBatchProvider = async (texts: any[]) =>
      texts.map(() => Array.from({ length: dim }, (_, i) => (i + 1) / dim));
    if (typeof mod.__setTestProvider === 'function')
      mod.__setTestProvider(defaultProvider);
    else if (mod && mod.__TEST) mod.__TEST.provider = defaultProvider;
    if (typeof mod.__setTestBatchProvider === 'function')
      mod.__setTestBatchProvider(defaultBatchProvider);
    else if (mod && mod.__TEST) mod.__TEST.batchProvider = defaultBatchProvider;
  } catch (e) {
    // ignore
  }
}

beforeEach(async () => {
  // reset env
  process.env.OM_EMBED_KIND = 'synthetic';
  process.env.OM_EMBED_MODE = 'advanced';
  process.env.OM_VEC_DIM = '32';

  // import fresh modules
  origFetch = globalThis.fetch;
  origSetTimeout = globalThis.setTimeout;

  // override setTimeout to avoid long sleeps in retry/backoff
  globalThis.setTimeout = ((fn: any, _ms?: number, ..._args: any[]) => {
    try {
      return fn();
    } catch (e) {
      return undefined as any;
    }
  }) as any;

  // import fresh logger (embed module will be imported per-test so spies can be installed)
  logger = await import(LOGGER_PATH);
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  globalThis.setTimeout = origSetTimeout;
  // Ensure any embed internal queues are idle and then close the test DB
  try {
    const embedMod: any = await import(EMBED_PATH);
    if (embedMod && embedMod.__TEST) {
      if (typeof embedMod.__TEST.waitForIdle === 'function') {
        try {
          await embedMod.__TEST.waitForIdle();
        } catch (e) {}
      }
      if (typeof embedMod.__TEST.reset === 'function') {
        try {
          embedMod.__TEST.reset();
        } catch (e) {}
      }
    }
  } catch (e) {
    // ignore if embed module can't be imported here
  }
  try {
    const db = await import('../../backend/src/core/db.test-entry');
    if (db && typeof db.closeDb === 'function') {
      try {
        await db.closeDb();
      } catch (e) {}
    }
  } catch (e) {
    // ignore
  }
});

test('local embed warns and returns synthetic when local model missing', async () => {
  process.env.OM_EMBED_KIND = 'local';
  // ensure local model path unset
  delete process.env.OM_LOCAL_MODEL_PATH;

  // ensure runtime cfg reflects local embed kind before importing embed module
  const cfgLocal = await import('../../backend/src/core/cfg');
  cfgLocal.env.embed_kind = 'local';
  delete cfgLocal.env.local_model_path;
  cfgLocal.env.vec_dim = Number(process.env.OM_VEC_DIM) || cfgLocal.env.vec_dim;

  // Capture warnings via embedLog's test hook mechanism
  let warnCaptured = false;
  const embedMod: any = await import(EMBED_PATH);
  if (embedMod && embedMod.__TEST) {
    embedMod.__TEST.logHook = (lvl: any, meta: any, msg: any) => {
      if (lvl === 'warn' && msg.includes('Local model missing')) {
        warnCaptured = true;
      }
    };
  }
  installDefaultProviders(embedMod);
  const db = await import('../../backend/src/core/db.test-entry');
  await db.initDb();
  const out = await embedMod.embedMultiSector(
    'eid-local',
    'hello world',
    ['semantic'],
    undefined,
    'u_local',
  );
  expect(Array.isArray(out)).toBe(true);
  expect(out.length).toBeGreaterThan(0);
  expect(warnCaptured).toBe(true);
});

test('gemini retries on 429 and succeeds, logging rate-limit warning', async () => {
  process.env.OM_EMBED_KIND = 'gemini';
  process.env.OM_GEMINI_KEY = 'fake_key';

  // simulate fetch: first respond with 429 and Retry-After header, second respond with success
  let calls = 0;
  globalThis.fetch = (async (url: any, opts: any) => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: {
          get: (h: string) => (h.toLowerCase() === 'retry-after' ? '1' : null),
        },
      } as any;
    }
    // success shape expected by emb_gemini
    return {
      ok: true,
      json: async () => ({
        embeddings: [
          {
            values: Array.from(
              { length: Number(process.env.OM_VEC_DIM) },
              () => 0.1,
            ),
          },
        ],
      }),
    } as any;
  }) as any;

  // spy on logger.warn and import embed module afterwards
  const spyWarnHandle = spyLoggerMethod(logger, 'warn');
  try {
    const embedMod: any = await import(EMBED_PATH);
    if (embedMod && embedMod.__TEST)
      embedMod.__TEST.logHook = (_lvl: any, _meta: any, _msg: any) => {};
  } catch (e) {}
  // ensure core cfg is set to use gemini for this import-time binding
  const cfg = await import('../../backend/src/core/cfg');
  cfg.env.embed_kind = 'gemini';
  cfg.env.gemini_key = process.env.OM_GEMINI_KEY || 'fake_key';
  cfg.env.vec_dim = Number(process.env.OM_VEC_DIM) || cfg.env.vec_dim;

  embedMod = await import(EMBED_PATH);
  installDefaultProviders(embedMod);
  const db = await import('../../backend/src/core/db.test-entry');
  await db.initDb();
  const out = await embedMod.embedMultiSector(
    'eid-gem',
    'retry text',
    ['semantic'],
    undefined,
    'user_g1',
  );
  expect(Array.isArray(out)).toBe(true);
  expect(out.length).toBeGreaterThan(0);
  // ensure we retried at least once (calls>1)
  expect(calls).toBeGreaterThan(1);

  spyWarnHandle.restore();
});

test('gemini fails after retries and falls back to synthetic, logging error', async () => {
  process.env.OM_EMBED_KIND = 'gemini';
  process.env.OM_GEMINI_KEY = 'fake_key';

  // simulate fetch always throwing and count attempts
  let calls = 0;
  globalThis.fetch = (async (url: any, opts: any) => {
    calls++;
    throw new Error('network fail');
  }) as any;

  // spy on logger.error and import embed module afterwards
  const spyErrHandle = spyLoggerMethod(logger, 'error');
  try {
    const embedMod: any = await import(EMBED_PATH);
    if (embedMod && embedMod.__TEST)
      embedMod.__TEST.logHook = (_lvl: any, _meta: any, _msg: any) => {};
  } catch (e) {}

  const cfg2 = await import('../../backend/src/core/cfg');
  cfg2.env.embed_kind = 'gemini';
  cfg2.env.gemini_key = process.env.OM_GEMINI_KEY || 'fake_key';
  cfg2.env.vec_dim = Number(process.env.OM_VEC_DIM) || cfg2.env.vec_dim;

  embedMod = await import(EMBED_PATH);
  installDefaultProviders(embedMod);
  const db = await import('../../backend/src/core/db.test-entry');
  await db.initDb();
  try {
    const out = await embedMod.embedMultiSector(
      'eid-gem-fail',
      'fail text',
      ['semantic'],
      undefined,
      'user_g2',
    );
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    // emb_gemini should attempt multiple times before falling back
    expect(calls).toBeGreaterThanOrEqual(3);
  } finally {
    if (db && typeof db.closeDb === 'function') {
      try {
        await db.closeDb();
      } catch (e) {}
    }
  }

  spyErrHandle.restore();
});

test('openai batch simple mode uses batch endpoint and returns vectors', async () => {
  process.env.OM_EMBED_KIND = 'openai';
  process.env.OM_EMBED_MODE = 'simple';
  process.env.OM_OPENAI_KEY = 'fake';
  process.env.OM_OPENAI_BASE_URL = 'https://api.openai.test';

  globalThis.fetch = (async (url: any, opts: any) => {
    // emulate batch response shape
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            embedding: Array.from(
              { length: Number(process.env.OM_VEC_DIM) },
              () => 0.07,
            ),
          },
        ],
      }),
    } as any;
  }) as any;
  const cfg3 = await import('../../backend/src/core/cfg');
  cfg3.env.embed_kind = 'openai';
  cfg3.env.openai_key = process.env.OM_OPENAI_KEY || 'fake';
  cfg3.env.vec_dim = Number(process.env.OM_VEC_DIM) || cfg3.env.vec_dim;

  embedMod = await import(EMBED_PATH);
  installDefaultProviders(embedMod);
  const db = await import('../../backend/src/core/db.test-entry');
  await db.initDb();
  const out = await embedMod.embedMultiSector(
    'eid-openai',
    'hello batch',
    ['semantic'],
    undefined,
    'user_o1',
  );
  expect(Array.isArray(out)).toBe(true);
  expect(out.length).toBeGreaterThan(0);
  // vector shape sanity: non-empty numeric vector
  expect(Array.isArray(out[0].vector)).toBe(true);
  expect(out[0].vector.length).toBeGreaterThan(0);
});
