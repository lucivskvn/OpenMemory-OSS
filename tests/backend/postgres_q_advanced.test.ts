import { test, expect } from 'bun:test';
import crypto from 'crypto';

async function waitFor(
  predicate: () => Promise<boolean>,
  attempts = 40,
  delayMs = 250,
) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await predicate()) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

test(
  'postgres q advanced: json/array params, prepared reuse, error paths',
  async () => {
    if (process.env.OM_METADATA_BACKEND !== 'postgres') return;

    process.env.OM_NO_AUTO_START = 'true';
    const mod = await import('../../backend/src/core/db.ts');
    const { initDb } = mod as any;

    await initDb();

    try {
      const ready = await waitFor(
        async () => {
          try {
            if (!mod.memories_table) return false;
            await mod.get_async(`select 1 as v`);
            return true;
          } catch (e) {
            return false;
          }
        },
        80,
        250,
      );

      expect(ready).toBe(true);

      const run = mod.run_async;
      const get = mod.get_async;
      const all = mod.all_async;
      const memTable = mod.memories_table;

      // JSON param binding: insert a JSON meta blob and read it back
      const idJson = crypto.randomUUID();
      const meta = { tags: ['a', 'b'], nested: { n: 5 } };
      const now = Date.now();
      await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,meta,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7)`,
        [
          idJson,
          'pg-adv',
          'json-test',
          'pg-q-adv',
          JSON.stringify(meta),
          now,
          now,
        ],
      );
      const got = await get(`select meta from ${memTable} where id=$1`, [
        idJson,
      ]);
      // Some Postgres clients return JSON as string, others already parsed; accept both
      const parsed =
        typeof got.meta === 'string' ? JSON.parse(got.meta) : got.meta;
      expect(parsed.nested.n).toBe(5);

      // Array binding: use Postgres array literal via parameter binding - pass as JS array
      const idArr1 = crypto.randomUUID();
      const arr = ['x', 'y', 'z'];
      await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,tags,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7)`,
        [
          idArr1,
          'pg-adv',
          'arr-test',
          'pg-q-adv',
          JSON.stringify(arr),
          now,
          now,
        ],
      );
      const gotArr = await get(`select tags from ${memTable} where id=$1`, [
        idArr1,
      ]);
      const parsedArr =
        typeof gotArr.tags === 'string' ? JSON.parse(gotArr.tags) : gotArr.tags;
      expect(Array.isArray(parsedArr)).toBe(true);

      // Prepared statement reuse: run the same query multiple times to ensure parameter substitution remains correct
      const reuseIds = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      for (const rid of reuseIds) {
        await run(
          `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
          [rid, 'pg-adv', 'reuse', 'pg-q-adv', Date.now(), Date.now()],
        );
      }
      const found = await all(
        `select id from ${memTable} where content = $1 order by id`,
        ['reuse'],
      );
      expect(found.length).toBeGreaterThanOrEqual(3);

      // Error path behavior: deliberate SQL error should surface as an exception and not hang driver
      let sawError = false;
      try {
        await run(`select * from definitely_not_a_table`);
      } catch (e: any) {
        sawError = true;
        // should be a DB error object with message
        expect(e).toBeDefined();
        expect(e.message || e.toString()).toMatch(
          /no such table|relation .* does not exist|does not exist/i,
        );
      }
      expect(sawError).toBe(true);

      // Cleanup
      await run(`delete from ${memTable} where primary_sector = $1`, [
        'pg-q-adv',
      ]);
      await run(`delete from ${memTable} where id in ($1,$2,$3,$4)`, [
        idJson,
        idArr1,
        ...reuseIds,
      ]);
    } finally {
      if (mod && typeof (mod as any).closeDb === 'function') {
        try {
          await (mod as any).closeDb();
        } catch (e) {
          /* best-effort */
        }
      }
    }
  },
  { timeout: 120_000 },
);
