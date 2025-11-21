import { test, expect } from 'bun:test';
import path from 'path';

test('DB console prefix appears when OM_DB_CONSOLE and user-scope warn enabled', async () => {
  // Capture console outputs
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.warn = (...args: any[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: any[]) => {
    logs.push(args.map(String).join(' '));
  };

  // Enable console-prefixed DB messages and user-scope warnings for this test only
  const _prev_console = process.env.OM_DB_CONSOLE;
  const _prev_warn = process.env.OM_DB_USER_SCOPE_WARN;
  const _prev_db_path = process.env.OM_DB_PATH;
  const _prev_meta = process.env.OM_METADATA_BACKEND;
  process.env.OM_DB_CONSOLE = 'true';
  process.env.OM_DB_USER_SCOPE_WARN = 'true';
  process.env.OM_DB_PATH = ':memory:';
  process.env.OM_METADATA_BACKEND = 'sqlite';

  let mod: any;
  try {
    mod = await import('../../backend/src/core/db.test-entry');
    // Call initDb before reading live bindings from the module namespace.
    await mod.initDb();
    const q = mod.q;
    // Trigger a query that references user_id without supplying it
    // get_vec will execute SQL containing 'user_id' and pass nulls for the user_id params.
    await q.get_vec.get('no-such-id', 'semantic');

    // Give a small tick for any async console writes
    await new Promise((r) => setTimeout(r, 20));

    const found = logs.some(
      (l) => l.includes('[DB]') || l.includes('DB query referencing user_id'),
    );
    expect(found).toBe(true);
  } finally {
    try {
      if (mod && typeof mod.closeDb === 'function') await mod.closeDb();
    } catch (e) {
      /* best-effort */
    }
    // Restore console
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    // Restore previous env vars so this test does not leak observability flags to other tests
    if (_prev_console === undefined) delete process.env.OM_DB_CONSOLE;
    else process.env.OM_DB_CONSOLE = _prev_console;
    if (_prev_warn === undefined) delete process.env.OM_DB_USER_SCOPE_WARN;
    else process.env.OM_DB_USER_SCOPE_WARN = _prev_warn;
    if (_prev_db_path === undefined) delete process.env.OM_DB_PATH;
    else process.env.OM_DB_PATH = _prev_db_path;
    if (_prev_meta === undefined) delete process.env.OM_METADATA_BACKEND;
    else process.env.OM_METADATA_BACKEND = _prev_meta;
  }
});
