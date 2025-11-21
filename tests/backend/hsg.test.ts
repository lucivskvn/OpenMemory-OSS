import { test, expect, beforeEach, afterEach } from 'bun:test';

process.env.OM_TEST_MODE = '1';
process.env.OM_DB_PATH = ':memory:';
process.env.OM_METADATA_BACKEND = 'sqlite';

import * as hsg from '../../backend/src/memory/hsg';
import { initDb, closeDb } from '../../backend/src/core/db.test-entry';

beforeEach(async () => {
    await initDb();
});

afterEach(async () => {
    try { await closeDb(); } catch (e) { }
});

test('hsg __TEST.logHook can be installed and reset', async () => {
    const mux: any[] = [];
    if (hsg && (hsg as any).__TEST) (hsg as any).__TEST.logHook = (_l: any, meta: any, msg: any) => { mux.push({ meta, msg }); };

    // call a simple hsg helper that should not crash; we only test the hook installation
    expect(typeof hsg.classify_content === 'function').toBeTruthy();

    // reset the hook and ensure it's null
    if (hsg && (hsg as any).__TEST && typeof (hsg as any).__TEST.reset === 'function') (hsg as any).__TEST.reset();
    expect((hsg as any).__TEST.logHook).toBeNull();
});
