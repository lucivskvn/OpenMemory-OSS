import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

// This test file exercises the Postgres metadata backend.
// It expects a Postgres instance reachable at localhost:5432 matching
// the credentials in docker-compose.yml (openmemory/openmemory/openmemory).

process.env.OM_METADATA_BACKEND = 'postgres';
process.env.OM_ENABLE_PG = 'true';
process.env.OM_PG_HOST = process.env.OM_PG_HOST || '127.0.0.1';
process.env.OM_PG_PORT = process.env.OM_PG_PORT || '5432';
process.env.OM_PG_DB = process.env.OM_PG_DB || 'openmemory';
process.env.OM_PG_USER = process.env.OM_PG_USER || 'openmemory';
process.env.OM_PG_PASSWORD = process.env.OM_PG_PASSWORD || 'openmemory';
process.env.OM_PG_SCHEMA = process.env.OM_PG_SCHEMA || 'public';

let skip = false;
let dbExports;

beforeAll(async () => {
  try {
    dbExports = await import('../../backend/src/core/db.test-entry');
    // Attempt to initialize; if Postgres isn't up this may throw.
    await dbExports.initDb();
  } catch (e) {
    // Skip tests when Postgres is unavailable; the runner script will
    // bring up Postgres and re-run this test in CI. Mark skip flag.
    console.warn(
      '[tests] Postgres not available; skipping Postgres integration tests:',
      String(e),
    );
    skip = true;
  }
});

afterAll(async () => {
  if (!skip && dbExports && typeof dbExports.closeDb === 'function') {
    try {
      await dbExports.closeDb();
    } catch (e) {
      console.warn(
        '[tests] Warning while closing DB after Postgres tests:',
        String(e),
      );
    }
  }
});

describe('Postgres metadata backend integration', () => {
  it('inserts and isolates per-user data (Postgres)', async () => {
    if (skip) return;
    const { q } = dbExports;
    const now = Date.now();
    await q.ins_mem.run(
      'pg-user1',
      'pg one',
      'semantic',
      '[]',
      '{}',
      now,
      now,
      now,
      1.0,
      0.1,
      1,
      'pg_user1',
    );
    await q.ins_mem.run(
      'pg-user2',
      'pg two',
      'semantic',
      '[]',
      '{}',
      now,
      now,
      now,
      1.0,
      0.1,
      1,
      'pg_user2',
    );

    const u1 = await q.all_mem_by_user.all('pg_user1', 10, 0);
    const u2 = await q.all_mem_by_user.all('pg_user2', 10, 0);
    expect(u1.length).toBe(1);
    expect(u2.length).toBe(1);
  });

  it('transaction rollback works on Postgres', async () => {
    if (skip) return;
    const { q, transaction } = dbExports;
    const id = 'pg-tx-1';
    const now = Date.now();
    await transaction.begin();
    try {
      await q.ins_mem.run(
        id,
        'will rollback pg',
        'semantic',
        '[]',
        '{}',
        now,
        now,
        now,
        1.0,
        0.1,
        1,
        'pg_user_tx',
      );
      throw new Error('simulated');
    } catch (e) {
      await transaction.rollback();
    }
    const got = await q.get_mem.get(id, 'pg_user_tx');
    expect(got === undefined || got === null).toBe(true);
  });

  it('vectors and waypoints enforce per-user isolation (Postgres)', async () => {
    if (skip) return;
    const { q } = dbExports;
    const now = Date.now();
    const dim = 8;
    const a = new Float32Array(dim).fill(0).map((v, i) => i / dim);
    const b = new Float32Array(dim).fill(0).map((v, i) => (i + 1) / dim);
    const bufA = Buffer.from(a.buffer);
    const bufB = Buffer.from(b.buffer);

    await q.ins_vec.run('pg-vec-1', 'semantic', 'pg_user1', bufA, dim);
    await q.ins_vec.run('pg-vec-2', 'semantic', 'pg_user2', bufB, dim);

    const got1 = await q.get_vec.get('pg-vec-1', 'semantic', 'pg_user1');
    expect(got1).toBeTruthy();
    const got2_for_user1 = await q.get_vec.get(
      'pg-vec-2',
      'semantic',
      'pg_user1',
    );
    expect(got2_for_user1 === undefined || got2_for_user1 === null).toBe(true);

    await q.ins_waypoint.run('pg-src-1', 'pg-dst-a', 'pg_user1', 1.0, now, now);
    await q.ins_waypoint.run('pg-src-1', 'pg-dst-b', 'pg_user2', 0.5, now, now);
    const neighs_user1 = await q.get_neighbors.all('pg-src-1', 'pg_user1');
    expect(neighs_user1.length).toBe(1);
    expect(neighs_user1[0].dst_id).toBe('pg-dst-a');

    // strict mode should reject deletions without user_id
    process.env.OM_STRICT_TENANT = 'true';
    await dbExports.initDb();
    let threw = false;
    try {
      await q.del_vec.run('pg-vec-1');
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(true);
    delete process.env.OM_STRICT_TENANT;
    await dbExports.initDb();
  });
});
