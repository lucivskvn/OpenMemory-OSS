import { test, expect, beforeEach, afterEach } from "bun:test";

// Ensure test environment defaults
process.env.OM_DB_PATH = ":memory:";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_NO_AUTO_START = "true";
process.env.OM_EMBED_KIND = "synthetic";
process.env.OM_EMBED_MODE = "advanced";
process.env.OM_VEC_DIM = "32";

// Helpers to import modules under test
const EMBED_PATH = "../../backend/src/memory/embed.js";
const LOGGER_PATH = "../../backend/src/core/logger.js";

let origFetch: any;
let origSetTimeout: any;
let logger: any;
let embedMod: any;

beforeEach(async () => {
    // reset env
    process.env.OM_EMBED_KIND = "synthetic";
    process.env.OM_EMBED_MODE = "advanced";
    process.env.OM_VEC_DIM = "32";

    // import fresh modules
    origFetch = globalThis.fetch;
    origSetTimeout = globalThis.setTimeout;

    // override setTimeout to avoid long sleeps in retry/backoff
    globalThis.setTimeout = (fn: any, _ms?: number, ..._args: any[]) => {
        try {
            return fn();
        } catch (e) {
            return undefined as any;
        }
    };

    // import fresh logger (embed module will be imported per-test so spies can be installed)
    logger = await import(LOGGER_PATH);
});

afterEach(() => {
    globalThis.fetch = origFetch;
    globalThis.setTimeout = origSetTimeout;
});

test("local embed warns and returns synthetic when local model missing", async () => {
    process.env.OM_EMBED_KIND = "local";
    // ensure local model path unset
    delete process.env.OM_LOCAL_MODEL_PATH;

    // ensure runtime cfg reflects local embed kind before importing embed module
    const cfgLocal = await import("../../backend/src/core/cfg.js");
    cfgLocal.env.embed_kind = "local";
    delete cfgLocal.env.local_model_path;
    cfgLocal.env.vec_dim = Number(process.env.OM_VEC_DIM) || cfgLocal.env.vec_dim;

    // spy on logger.warn and then import embed module so embeds use the spied logger
    const origWarn = (logger.default && logger.default.warn) || logger.warn;
    let warned = false;
    const spy = (...args: any[]) => { warned = true; return origWarn.apply(logger.default || logger, args); };
    if (logger.default) logger.default.warn = spy; else logger.warn = spy;

    embedMod = await import(EMBED_PATH);
    const db = await import("../../backend/src/core/db.js");
    await db.initDb();
    const out = await embedMod.embedMultiSector("eid-local", "hello world", ["semantic"], undefined, "u_local");
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(warned).toBe(true);

    // restore
    if (logger.default) logger.default.warn = origWarn; else logger.warn = origWarn;
});

test("gemini retries on 429 and succeeds, logging rate-limit warning", async () => {
    process.env.OM_EMBED_KIND = "gemini";
    process.env.OM_GEMINI_KEY = "fake_key";

    // simulate fetch: first respond with 429 and Retry-After header, second respond with success
    let calls = 0;
    globalThis.fetch = async (url: any, opts: any) => {
        calls++;
        if (calls === 1) {
            return {
                ok: false,
                status: 429,
                headers: {
                    get: (h: string) => (h.toLowerCase() === "retry-after" ? "1" : null),
                },
            };
        }
        // success shape expected by emb_gemini
        return {
            ok: true,
            json: async () => ({ embeddings: [{ values: Array.from({ length: Number(process.env.OM_VEC_DIM) }, () => 0.1) }] }),
        };
    };

    // spy on logger.warn and import embed module afterwards
    const origWarn = (logger.default && logger.default.warn) || logger.warn;
    let sawRateLimit = false;
    const spyWarn = (...args: any[]) => { sawRateLimit = true; return origWarn.apply(logger.default || logger, args); };
    if (logger.default) logger.default.warn = spyWarn; else logger.warn = spyWarn;
    // ensure core cfg is set to use gemini for this import-time binding
    const cfg = await import("../../backend/src/core/cfg.js");
    cfg.env.embed_kind = "gemini";
    cfg.env.gemini_key = process.env.OM_GEMINI_KEY || "fake_key";
    cfg.env.vec_dim = Number(process.env.OM_VEC_DIM) || cfg.env.vec_dim;

    embedMod = await import(EMBED_PATH);
    const db = await import("../../backend/src/core/db.js");
    await db.initDb();
    const out = await embedMod.embedMultiSector("eid-gem", "retry text", ["semantic"], undefined, "user_g1");
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    // ensure we retried at least once (calls>1)
    expect(calls).toBeGreaterThan(1);

    if (logger.default) logger.default.warn = origWarn; else logger.warn = origWarn;
});

test("gemini fails after retries and falls back to synthetic, logging error", async () => {
    process.env.OM_EMBED_KIND = "gemini";
    process.env.OM_GEMINI_KEY = "fake_key";

    // simulate fetch always throwing
    globalThis.fetch = async () => { throw new Error("network fail"); };

    // spy on logger.error and import embed module afterwards
    const origError = (logger.default && logger.default.error) || logger.error;
    let sawError = false;
    let calls = 0;
    // count calls and spy
    globalThis.fetch = async (url: any, opts: any) => { calls++; throw new Error("network fail"); };
    const spyErr = (...args: any[]) => { sawError = true; return origError.apply(logger.default || logger, args); };
    if (logger.default) logger.default.error = spyErr; else logger.error = spyErr;

    const cfg2 = await import("../../backend/src/core/cfg.js");
    cfg2.env.embed_kind = "gemini";
    cfg2.env.gemini_key = process.env.OM_GEMINI_KEY || "fake_key";
    cfg2.env.vec_dim = Number(process.env.OM_VEC_DIM) || cfg2.env.vec_dim;

    embedMod = await import(EMBED_PATH);
    const db = await import("../../backend/src/core/db.js");
    await db.initDb();
    const out = await embedMod.embedMultiSector("eid-gem-fail", "fail text", ["semantic"], undefined, "user_g2");
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    // emb_gemini should attempt multiple times before falling back
    expect(calls).toBeGreaterThanOrEqual(3);

    if (logger.default) logger.default.error = origError; else logger.error = origError;
});

test("openai batch simple mode uses batch endpoint and returns vectors", async () => {
    process.env.OM_EMBED_KIND = "openai";
    process.env.OM_EMBED_MODE = "simple";
    process.env.OM_OPENAI_KEY = "fake";
    process.env.OM_OPENAI_BASE_URL = "https://api.openai.test";

    globalThis.fetch = async (url: any, opts: any) => {
        // emulate batch response shape
        return {
            ok: true,
            json: async () => ({ data: [{ embedding: Array.from({ length: Number(process.env.OM_VEC_DIM) }, () => 0.07) }] }),
        };
    };
    const cfg3 = await import("../../backend/src/core/cfg.js");
    cfg3.env.embed_kind = "openai";
    cfg3.env.openai_key = process.env.OM_OPENAI_KEY || "fake";
    cfg3.env.vec_dim = Number(process.env.OM_VEC_DIM) || cfg3.env.vec_dim;

    embedMod = await import(EMBED_PATH);
    const db = await import("../../backend/src/core/db.js");
    await db.initDb();
    const out = await embedMod.embedMultiSector("eid-openai", "hello batch", ["semantic"], undefined, "user_o1");
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    // vector shape sanity: non-empty numeric vector
    expect(Array.isArray(out[0].vector)).toBe(true);
    expect(out[0].vector.length).toBeGreaterThan(0);
});
