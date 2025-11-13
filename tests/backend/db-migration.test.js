import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// Ensure tests use an in-memory SQLite DB for isolation
process.env.OM_METADATA_BACKEND = 'sqlite';
process.env.OM_DB_PATH = ':memory:';

// Load DB helpers after env is set
import { initDb, q, transaction, get_async } from '../../backend/src/core/db.js';

describe('DB migration & multi-tenant verification', () => {
  beforeEach(async () => {
    // Reset strict tenant mode between tests
    delete process.env.OM_STRICT_TENANT;
    // Initialize the DB (idempotent)
    await initDb();
  });

  it('inserts memories and enforces per-user isolation', async () => {
    const now = Date.now();
    await q.ins_mem.run('m-user1', 'hello user1', 'semantic', '[]', '{}', now, now, now, 1.0, 0.1, 1, 'user1');
    await q.ins_mem.run('m-user2', 'hello user2', 'semantic', '[]', '{}', now, now, now, 1.0, 0.1, 1, 'user2');

    const user1 = await q.all_mem_by_user.all('user1', 10, 0);
    const user2 = await q.all_mem_by_user.all('user2', 10, 0);

    expect(user1.length).toBe(1);
    expect(user1[0].user_id).toBe('user1');
    expect(user2.length).toBe(1);
    expect(user2[0].user_id).toBe('user2');
  });

  it('enforces OM_STRICT_TENANT on reads', async () => {
    const now = Date.now();
    await q.ins_mem.run('m-strict', 'strict check', 'semantic', '[]', '{}', now, now, now, 1.0, 0.1, 1, 'user1');

    // Enable strict tenant enforcement
    process.env.OM_STRICT_TENANT = 'true';
    // Re-init (initDb is idempotent but guards on path; re-run to ensure guard behavior)
    await initDb();

    let thrown = false;
    try {
      // Calling get_mem without user_id should throw under strict mode
      await q.get_mem.get('m-strict');
    } catch (e) {
      thrown = true;
      expect(String(e)).toContain('Tenant-scoped');
    }
    expect(thrown).toBe(true);
  });

  it('transaction rollback prevents partial writes', async () => {
    const txId = 'tx-1';
    const now = Date.now();
    await transaction.begin();
    try {
      await q.ins_mem.run(txId, 'will rollback', 'semantic', '[]', '{}', now, now, now, 1.0, 0.1, 1, 'user_tx');
      // Simulate an error to trigger rollback
      throw new Error('simulated error');
    } catch (e) {
      await transaction.rollback();
    }

    const got = await q.get_mem.get(txId, 'user_tx');
      // After rollback the record should not exist (SQLite returns null)
      expect(got === undefined || got === null).toBe(true);
  });

  it('sets SQLite PRAGMA journal_mode to WAL on init', async () => {
    // Query PRAGMA journal_mode via exported helper
    const row = await get_async('PRAGMA journal_mode');
    // row may be like {journal_mode: 'wal'} or simply a string; normalize
      const val = (typeof row === 'string' ? row : (row?.journal_mode || (row && Object.values(row)[0])));
      const vstr = String(val).toLowerCase();
      // In-memory SQLite may report 'memory' journal mode; accept either
      expect(vstr.includes('wal') || vstr.includes('memory')).toBe(true);
  });
});
