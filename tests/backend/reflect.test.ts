import { test, expect, beforeEach } from 'bun:test';

process.env.OM_TEST_MODE = '1';
process.env.OM_DB_PATH = ':memory:';
process.env.OM_METADATA_BACKEND = 'sqlite';

import { run_reflection, __TEST as reflectTest } from '../../backend/src/memory/reflect';
import { initDb, closeDb } from '../../backend/src/core/db.test-entry';

beforeEach(async () => {
    await initDb();
});

test('run_reflection logs reflect info when not enough memories', async () => {
    const captured: any[] = [];
    if (reflectTest) reflectTest.logHook = (_lvl: any, meta: any, msg: any) => captured.push({ meta, msg });

    const res = await run_reflection();
    expect(res).toHaveProperty('created');

    // ensure that something in the reflect path was logged
    expect(captured.length).toBeGreaterThanOrEqual(1);

    // cleanup
    if (reflectTest) reflectTest.logHook = null;
    await closeDb();
});
