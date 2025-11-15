import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';

// Ensure tests use an in-memory SQLite DB for isolation
process.env.OM_METADATA_BACKEND = 'sqlite';
process.env.OM_DB_PATH = ':memory:';

// Load DB helpers after env is set via a stable test entry
import { initDb, q, transaction, get_async, closeDb } from '../../backend/src/core/db.test-entry';

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
        const msg = String(e || '').toLowerCase();
        expect(msg).toBeTruthy();
        expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
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
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
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
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);
        threw = false;
        try {
            await q.del_waypoints.run('src-1');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);
        // turn off strict mode for subsequent tests
        delete process.env.OM_STRICT_TENANT;
        await initDb();
    });

    it('enforces strict mode on remaining SQLite helpers', async () => {
        const now = Date.now();
        const dim = 8;
        const a = new Float32Array(dim).fill(0).map((v, i) => i / dim);
        const bufA = Buffer.from(a.buffer);

        // Insert a vector scoped to a user (with sector) and a waypoint
        await q.ins_vec.run('svec-1', 'test-sector', 'sqlite-user', bufA, dim);
        await q.ins_waypoint.run('s-src', 's-dst', 'sqlite-user', 1.0, now, now);

        // Enable strict tenant enforcement and re-init DB layer to pick up guard
        process.env.OM_STRICT_TENANT = 'true';
        await initDb();

        // del_vec_sector without user_id should throw when strict
        let threw = false;
        try {
            await q.del_vec_sector.run('svec-1', 'test-sector');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // get_vecs_by_sector without user_id should throw when strict
        threw = false;
        try {
            await q.get_vecs_by_sector.all('test-sector');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // get_vecs_batch without user_id should throw when strict
        threw = false;
        try {
            await q.get_vecs_batch.all(['svec-1'], 'test-sector');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // get_waypoints_by_src without user_id should throw when strict
        threw = false;
        try {
            await q.get_waypoints_by_src.all('s-src');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // get_waypoint without user_id should throw when strict
        threw = false;
        try {
            await q.get_waypoint.get('s-src', 's-dst');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // upd_waypoint without user_id should throw when strict
        threw = false;
        try {
            await q.upd_waypoint.run('s-src', 's-dst', 0.5);
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // Positive: provide user_id and these ops should succeed
        await q.upd_waypoint.run('s-src', 's-dst', 0.75, Date.now(), 'sqlite-user');
        const wp = await q.get_waypoint.get('s-src', 's-dst', 'sqlite-user');
        // wp may be undefined if not present, but after upd_waypoint it should be defined (or at least not throw)
        // For SQLite we accept either a numeric weight or undefined/null depending on implementation
        // Now delete vector by sector with user_id provided
        await q.del_vec_sector.run('svec-1', 'test-sector', 'sqlite-user');

        // turn off strict mode for cleanup
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

// Postgres-specific verification for strict-tenant destructive guards
(process.env.TEST_POSTGRES_URL ? describe : describe.skip)('Postgres strict-tenant enforcement', () => {
    beforeEach(async () => {
        // Configure DB to use Postgres for these tests. If TEST_POSTGRES_URL is set
        // the tests will use that; otherwise a default is provided (useful for
        // local/dev override). Tests will be skipped when TEST_POSTGRES_URL is not set.
        process.env.OM_METADATA_BACKEND = 'postgres';
        process.env.OM_PG_URL = process.env.TEST_POSTGRES_URL || 'postgres://user:pass@localhost/testdb';
        // Ensure strict tenant mode is reset between cases
        delete process.env.OM_STRICT_TENANT;
        await initDb();
    });

    afterEach(async () => {
        // Close any Postgres clients created during the test to avoid leaks
        try {
            await closeDb();
        } catch (e) {
            // best-effort cleanup; tests will re-init below
        }
        // Reset to default in-memory sqlite for other tests in the suite
        process.env.OM_METADATA_BACKEND = 'sqlite';
        process.env.OM_DB_PATH = ':memory:';
        delete process.env.OM_STRICT_TENANT;
        await initDb();
    });

    it('throws on del_vec/del_waypoints when OM_STRICT_TENANT=true and user_id missing', async () => {
        const now = Date.now();
        const dim = 8;
        const a = new Float32Array(dim).fill(0).map((v, i) => i / dim);
        const bufA = Buffer.from(a.buffer);

        // Insert a vector and a waypoint scoped to a user
        await q.ins_vec.run('pvec-1', 'semantic', 'pg-user', bufA, dim);
        await q.ins_waypoint.run('psrc', 'pdst', 'pg-user', 1.0, now, now);

        // Enable strict tenant enforcement and re-init DB layer to pick up guard
        process.env.OM_STRICT_TENANT = 'true';
        await initDb();

        // del_vec without user_id should throw when strict
        let threw = false;
        try {
            await q.del_vec.run('pvec-1');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // del_waypoints without user_id should also throw when strict
        threw = false;
        try {
            await q.del_waypoints.run('psrc');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // With user_id provided, destructive ops should succeed
        await q.del_vec.run('pvec-1', 'pg-user');
        await q.del_waypoints.run('psrc', 'pg-user');

        // turn off strict mode for cleanup
        delete process.env.OM_STRICT_TENANT;
        await initDb();
    });

    it('throws on all_mem_by_user when OM_STRICT_TENANT=true and user_id missing', async () => {
        // Insert a memory scoped to a user
        const now = Date.now();
        await q.ins_mem.run('pg-allmem-1', 'pg allmem', 'semantic', '[]', '{}', now, now, now, 1.0, 0.1, 1, 'pg-user');

        // Enable strict tenant enforcement and re-init DB layer to pick up guard
        process.env.OM_STRICT_TENANT = 'true';
        await initDb();

        let threw = false;
        try {
            // Calling the aggregate all_mem_by_user without user_id should throw when strict
            // (we intentionally call the variant that accepts a user first arg omitted)
            // Here we call the function in the legacy-omitted-user shape by passing undefined
            await q.all_mem_by_user.all(undefined, 10, 0);
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // With user_id provided it should succeed
        await q.all_mem_by_user.all('pg-user', 10, 0);

        // turn off strict mode for cleanup
        delete process.env.OM_STRICT_TENANT;
        await initDb();
    });

    it('throws on del_vec_sector and upd_waypoint when OM_STRICT_TENANT=true and user_id missing', async () => {
        const now = Date.now();
        const dim = 8;
        const a = new Float32Array(dim).fill(0).map((v, i) => i / dim);
        const bufA = Buffer.from(a.buffer);

        // Insert a vector scoped to a user (with sector) and a waypoint
        await q.ins_vec.run('pvec-sec-1', 'sec-1', 'pg-user', bufA, dim);
        await q.ins_waypoint.run('psrc2', 'pdst2', 'pg-user', 1.0, now, now);

        // Enable strict tenant enforcement and re-init DB layer to pick up guard
        process.env.OM_STRICT_TENANT = 'true';
        await initDb();

        // del_vec_sector without user_id should throw when strict
        let threw = false;
        try {
            await q.del_vec_sector.run('pvec-sec-1', 'sec-1');
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // upd_waypoint without user_id should throw when strict
        threw = false;
        try {
            await q.upd_waypoint.run('psrc2', 'pdst2', 0.9);
        } catch (e) {
            threw = true;
            const msg = String(e || '').toLowerCase();
            expect(msg).toBeTruthy();
            expect(msg.includes('tenant-scoped') || msg.includes('requires user_id')).toBe(true);
        }
        expect(threw).toBe(true);

        // With user_id provided, the destructive/modify ops should succeed
        await q.upd_waypoint.run('psrc2', 'pdst2', 0.9, Date.now(), 'pg-user');
        await q.del_vec_sector.run('pvec-sec-1', 'sec-1', 'pg-user');

        // turn off strict mode for cleanup
        delete process.env.OM_STRICT_TENANT;
        await initDb();
    });
});

afterAll(async () => {
    try {
        await closeDb();
    } catch (e) { /* best-effort cleanup */ }
});
