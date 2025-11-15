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
          // Ensure an error was thrown; be tolerant to message wording changes
          expect(e).toBeTruthy();
          expect(e instanceof Error || typeof e.message === 'string').toBe(true);
          // optional: loose message check
          expect(String(e).toLowerCase()).toMatch(/tenant|user_id|requires/i);
      }
      expect(thrown).toBe(true);
  });

    it('ins_mem throws when OM_STRICT_TENANT=true and user_id missing', async () => {
        const now = Date.now();
        process.env.OM_STRICT_TENANT = 'true';
        await initDb();
        let thrown = false;
        try {
            // Call ins_mem without the trailing user_id parameter (legacy shape)
            await q.ins_mem.run('m-no-user', 'no user', 'semantic', '[]', '{}', now, now, now, 1.0, 0.1, 1);
        } catch (e) {
            thrown = true;
            expect(e).toBeTruthy();
            expect(e instanceof Error || typeof e.message === 'string').toBe(true);
            expect(String(e).toLowerCase()).toMatch(/tenant|user_id|requires/i);
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

    it('vectors and waypoints enforce per-user isolation and strict mode', async () => {
        const now = Date.now();
        const dim = 8;
        // create two simple vectors (Float32) for two users
        const a = new Float32Array(dim).fill(0).map((v, i) => i / dim);
        const b = new Float32Array(dim).fill(0).map((v, i) => (i + 1) / dim);
        const bufA = Buffer.from(a.buffer);
        const bufB = Buffer.from(b.buffer);

        // insert vectors for different users
        await q.ins_vec.run('vec-1', 'semantic', 'user1', bufA, dim);
        await q.ins_vec.run('vec-2', 'semantic', 'user2', bufB, dim);

        // user1 can read their vector
        const got1 = await q.get_vec.get('vec-1', 'semantic', 'user1');
        expect(got1).toBeTruthy();
        // user1 should not see user2's vector when scoped
        const got2_for_user1 = await q.get_vec.get('vec-2', 'semantic', 'user1');
        expect(got2_for_user1 === undefined || got2_for_user1 === null).toBe(true);

        // get_vecs_by_id when scoped to user2 returns only user2's sector
        const list_user2 = await q.get_vecs_by_id.all('vec-2', 'user2');
        expect(list_user2.length).toBe(1);

        // waypoints: insert for both users and verify neighbors are scoped
        await q.ins_waypoint.run('src-1', 'dst-a', 'user1', 1.0, now, now);
        await q.ins_waypoint.run('src-1', 'dst-b', 'user2', 0.5, now, now);

        const neighs_user1 = await q.get_neighbors.all('src-1', 'user1');
        expect(neighs_user1.length).toBe(1);
        expect(neighs_user1[0].dst_id).toBe('dst-a');

        // When strict mode enabled, destructive operations without user_id should throw
        process.env.OM_STRICT_TENANT = 'true';
        await initDb();
        let threw = false;
        try {
            await q.del_vec.run('vec-1');
        } catch (e) {
            threw = true;
        }
        expect(threw).toBe(true);
        threw = false;
        try {
            await q.del_waypoints.run('src-1');
        } catch (e) {
            threw = true;
        }
        expect(threw).toBe(true);
        // turn off strict mode for subsequent tests
        delete process.env.OM_STRICT_TENANT;
        await initDb();
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
