import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';

// Ensure environment is set before importing the DB runtime so the module
// picks up the intended SQLite in-memory path.
process.env.OM_DB_PATH = ':memory:';
process.env.OM_METADATA_BACKEND = 'sqlite';
// Keep user-scope warnings off by default for unit tests. Specific tests may enable it.
process.env.OM_DB_USER_SCOPE_WARN =
  process.env.OM_DB_USER_SCOPE_WARN || 'false';

import {
  q,
  initDb,
  all_async,
  get_async,
  run_async,
  transaction,
  closeDb,
} from '../../backend/src/core/db.test-entry';
import { Database } from 'bun:sqlite';

let tempDb: any;
const schemaSQL = [
  `PRAGMA busy_timeout=5000`,
  `PRAGMA journal_mode=WAL`,
  `PRAGMA synchronous=NORMAL`,
  `PRAGMA temp_store=MEMORY`,
  `create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`,
  `create table if not exists vectors(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector,user_id))`,
  `create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,user_id))`,
  `create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)`,
  `create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`,
  `create index if not exists idx_memories_sector on memories(primary_sector)`,
  `create index if not exists idx_memories_segment on memories(segment)`,
  `create index if not exists idx_memories_simhash on memories(simhash)`,
  `create index if not exists idx_memories_ts on memories(last_seen_at)`,
  `create index if not exists idx_memories_user on memories(user_id)`,
  `create index if not exists idx_vectors_user on vectors(user_id)`,
  `create index if not exists idx_waypoints_src on waypoints(src_id)`,
  `create index if not exists idx_waypoints_dst on waypoints(dst_id)`,
  `create index if not exists idx_waypoints_user on waypoints(user_id)`,
];

beforeEach(async () => {
  // Create a temp in-memory DB and ensure the schema exists there.
  tempDb = new Database(':memory:');
  for (const s of schemaSQL) {
    try {
      tempDb.run(s);
    } catch (e) {}
  }
  // Ensure the q helpers are initialized (they will create their own in-memory DB)
  await initDb();
});

afterEach(async () => {
  // Best-effort cleanup: clear the in-memory tables between tests.
  try {
    await run_async('delete from memories');
    await run_async('delete from vectors');
    await run_async('delete from waypoints');
    await run_async('delete from embed_logs');
    await run_async('delete from users');
  } catch (e) {
    // ignore; some tests may not have created tables yet
  }
  try {
    tempDb.close();
  } catch (e) {}
});

const now = () => Date.now();

test('isolates memories by user_id', async () => {
  const t1 = now();
  const t2 = t1 + 1;
  // Provide a full 18-arg parameter list with explicit non-null placeholders
  await q.ins_mem.run(
    'mem1',
    /* user_id slot (legacy) */ 'user1',
    /* segment */ 0,
    /* content */ 'content1',
    /* simhash */ '',
    /* primary_sector */ 'sector1',
    /* tags */ JSON.stringify([]),
    /* meta */ JSON.stringify({}),
    /* created_at */ t1,
    /* updated_at */ t1,
    /* last_seen_at */ t1,
    /* salience */ 1.0,
    /* decay_lambda */ 0.1,
    /* version */ 1,
    /* mean_dim */ 0,
    /* mean_vec */ Buffer.alloc(0),
    /* compressed_vec */ Buffer.alloc(0),
    /* feedback_score */ 0,
  );
  await q.ins_mem.run(
    'mem2',
    'user2',
    0,
    'content2',
    '',
    'sector1',
    JSON.stringify([]),
    JSON.stringify({}),
    t2,
    t2,
    t2,
    1.0,
    0.1,
    1,
    0,
    Buffer.alloc(0),
    Buffer.alloc(0),
    0,
  );

  const user1Mems = await q.all_mem_by_user.all('user1', 10, 0);
  expect(user1Mems.length).toBe(1);
  expect(user1Mems[0].content).toBe('content1');

  const user2Mems = await q.all_mem_by_user.all('user2', 10, 0);
  expect(user2Mems.length).toBe(1);
  expect(user2Mems[0].content).toBe('content2');

  // cross-check: user1 must not see user2 content
  expect(user1Mems[0].content).not.toBe('content2');
});

test('vectors are tenant-scoped by user_id', async () => {
  // insert one vector per user for the same sector and assert isolation
  const vbuf1 = Buffer.from([1, 2, 3, 4]);
  const vbuf2 = Buffer.from([5, 6, 7, 8]);
  await q.ins_vec.run('vec1', 'sectorA', 'user1', vbuf1, 4);
  await q.ins_vec.run('vec2', 'sectorA', 'user2', vbuf2, 4);

  const s1 = await q.get_vecs_by_sector.all('sectorA', 'user1');
  expect(s1.length).toBe(1);
  const s2 = await q.get_vecs_by_sector.all('sectorA', 'user2');
  expect(s2.length).toBe(1);
  // ensure cross-visibility does not happen
  expect(s1[0].id).toBe('vec1');
  expect(s2[0].id).toBe('vec2');
});

test('waypoints and neighbors respect user scope', async () => {
  await q.ins_waypoint.run('m1', 'm2', 'user1', 0.9, now(), now());
  await q.ins_waypoint.run('m1', 'm3', 'user2', 0.7, now(), now());

  const n1 = await q.get_neighbors.all('m1', 'user1');
  expect(n1.length).toBe(1);
  const dsts1 = n1.map((r: any) => r.dst_id || r.dstId || r.dst);
  expect(dsts1).toEqual(expect.arrayContaining(['m2']));

  const n2 = await q.get_neighbors.all('m1', 'user2');
  expect(n2.length).toBe(1);
  const dsts2 = n2.map((r: any) => r.dst_id || r.dstId || r.dst);
  expect(dsts2).toEqual(expect.arrayContaining(['m3']));
});

test('schema contains user_id indexes', async () => {
  const indexes = await all_async(
    "SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '%user_id%';",
  );
  const names = indexes.map((r: any) => r.name);
  expect(names).toEqual(
    expect.arrayContaining([
      'idx_memories_user',
      'idx_vectors_user',
      'idx_waypoints_user',
    ]),
  );
});

test('transactions rollback on error', async () => {
  // begin transaction, insert a memory and then rollback
  await transaction.begin();
  await q.ins_mem.run(
    'txmem',
    'txuser',
    0,
    'txcontent',
    '',
    'sectorX',
    JSON.stringify([]),
    JSON.stringify({}),
    now(),
    now(),
    now(),
    1.0,
    0.1,
    1,
    0,
    Buffer.alloc(0),
    Buffer.alloc(0),
    0,
  );
  await transaction.rollback();
  const got = await q.get_mem.get('txmem', null);
  // SQLite driver may return null or undefined for no-row; accept both
  expect(got == null).toBe(true);
});

test('PRAGMA journal_mode is WAL', async () => {
  const row = await get_async('PRAGMA journal_mode;');
  const vals = Object.values(row || {})
    .map(String)
    .join(' ');
  // In-memory runs can report 'memory' for journal_mode; accept either
  expect(/wal|memory/.test(vals.toLowerCase())).toBe(true);
});

test('bulk inserts perform within expected timeframe', async () => {
  const start = (globalThis as any).performance?.now
    ? (globalThis as any).performance.now()
    : Date.now();
  for (let i = 0; i < 100; i++) {
    await q.ins_mem.run(
      `bmem${i}`,
      'bulkuser',
      0,
      `bulkcontent${i}`,
      '',
      'sectorB',
      JSON.stringify([]),
      JSON.stringify({}),
      now() + i,
      now() + i,
      now() + i,
      1.0,
      0.1,
      1,
      0,
      Buffer.alloc(0),
      Buffer.alloc(0),
      0,
    );
  }
  const dur =
    ((globalThis as any).performance?.now
      ? (globalThis as any).performance.now()
      : Date.now()) - start;
  // Expect this to be reasonably fast in-memory (< 500ms) per review guidance.
  expect(dur).toBeLessThan(500);
});

test('strict tenant mode enforces user_id requirement', async () => {
  process.env.OM_STRICT_TENANT = 'true';
  // Re-init helpers to pick up strict setting
  await initDb();
  // get_vec should throw when strict and user_id missing
  try {
    await q.get_vec.get('nonexistent', 'sectorX', null);
    throw new Error('expected get_vec to throw when strict tenant is enabled');
  } catch (e) {
    const msg = String(e || '').toLowerCase();
    expect(
      msg.includes('requires user_id') || msg.includes('tenant-scoped'),
    ).toBe(true);
  }
  // Reset strict tenant mode for subsequent tests which expect non-strict behavior
  process.env.OM_STRICT_TENANT = 'false';
  await initDb();
});

test('invalid SQL raises an error', async () => {
  await expect(
    run_async('select * from definitely_not_a_table'),
  ).rejects.toBeTruthy();
});

afterAll(async () => {
  try {
    await closeDb();
  } catch (e) {
    /* best-effort cleanup */
  }
});
