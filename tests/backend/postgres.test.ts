import { test, expect } from 'bun:test';
import crypto from 'crypto';

// This test exercises Postgres-specific paths in backend/src/core/db.ts
// It runs only when OM_METADATA_BACKEND=postgres (CI job sets this).
// It verifies connection, schema creation, CRUD, transactions (savepoints),
// and multi-tenant isolation.

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
  'postgres: connection, schema, CRUD, transactions, multi-tenant isolation',
  async () => {
    if (process.env.OM_METADATA_BACKEND !== 'postgres') {
      if (process.env.TEST_DEBUG === '1')
        console.log(
          'Skipping Postgres tests (OM_METADATA_BACKEND != postgres)',
        );
      return;
    }

    // Ensure tests control server lifecycle where needed
    process.env.OM_NO_AUTO_START = 'true';

    const mod = await import('../../backend/src/core/db.ts');
    const { initDb } = mod as any;

    try {
      // Initialize DB layer (Postgres branch will run)
      await initDb();

      // Wait for run_async/get_async to become usable and for tables to exist
      const ready = await waitFor(
        async () => {
          try {
            // Basic connectivity check
            const one = await (mod.get_async ?? mod.get_async)('SELECT 1 as v');
            // Check memories table exists by selecting count (memories_table set by initDb)
            if (!mod.memories_table) return false;
            await (mod.get_async ?? mod.get_async)(
              `select count(*) as c from ${mod.memories_table}`,
            );
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
      const tx = mod.transaction;
      const memTable = mod.memories_table;

      // Clean slate: remove any test rows for our test prefix
      await run(`delete from ${memTable} where primary_sector = $1`, [
        'pg-test',
      ]);

      // Insert a memory for user1
      const id1 = crypto.randomUUID();
      const user1 = 'pg_user_1';
      const now = Date.now();
      await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
        [id1, user1, 'hello-pg-1', 'pg-test', now, now],
      );

      // Verify inserted
      const r1 = await get(`select * from ${memTable} where id=$1`, [id1]);
      expect(r1).toBeDefined();
      expect(r1.user_id).toBe(user1);
      expect(r1.content).toBe('hello-pg-1');

      // Insert for user2
      const id2 = crypto.randomUUID();
      const user2 = 'pg_user_2';
      await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
        [id2, user2, 'hello-pg-2', 'pg-test', now, now],
      );

      // Multi-tenant isolation: query only user1's rows
      const rowsUser1 = await all(
        `select * from ${memTable} where user_id=$1`,
        [user1],
      );
      expect(rowsUser1.length).toBeGreaterThanOrEqual(1);
      for (const r of rowsUser1) {
        expect(r.user_id).toBe(user1);
      }

      // Update content and verify
      await run(`update ${memTable} set content=$1,updated_at=$2 where id=$3`, [
        'updated-pg-1',
        Date.now(),
        id1,
      ]);
      const r1u = await get(`select content from ${memTable} where id=$1`, [
        id1,
      ]);
      expect(r1u.content).toBe('updated-pg-1');

      // Test transactions and savepoints: inner rollback should not affect outer committed changes
      await tx.begin();
      const txIdOuter = crypto.randomUUID();
      await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
        [txIdOuter, user1, 'tx-outer', 'pg-test', Date.now(), Date.now()],
      );
      // start nested
      await tx.begin();
      const txIdInner = crypto.randomUUID();
      await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
        [txIdInner, user1, 'tx-inner', 'pg-test', Date.now(), Date.now()],
      );
      // rollback inner
      await tx.rollback();
      // commit outer
      await tx.commit();

      const gotOuter = await get(`select * from ${memTable} where id=$1`, [
        txIdOuter,
      ]);
      expect(gotOuter).toBeDefined();
      const gotInner = await get(`select * from ${memTable} where id=$1`, [
        txIdInner,
      ]);
      expect(gotInner).toBeUndefined();

      // Test error rollback: start tx, insert, then rollback entire tx
      await tx.begin();
      const idErr = crypto.randomUUID();
      await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
        [idErr, user1, 'tx-err', 'pg-test', Date.now(), Date.now()],
      );
      await tx.rollback();
      const gotErr = await get(`select * from ${memTable} where id=$1`, [
        idErr,
      ]);
      expect(gotErr).toBeUndefined();

      // Concurrent inserts to validate pool behavior (simple parallel inserts)
      const concIds = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      await Promise.all(
        concIds.map((cid) =>
          run(
            `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
            [cid, user1, 'conc', 'pg-test', Date.now(), Date.now()],
          ),
        ),
      );
      const concRows = await all(
        `select * from ${memTable} where id in ($1,$2,$3)`,
        concIds,
      );
      // The helper all() above expects $1,$2,$3 style placeholders — ensure we got rows
      expect(concRows.length).toBeGreaterThanOrEqual(3);

      // Cleanup test rows we created
      await run(`delete from ${memTable} where primary_sector = $1`, [
        'pg-test',
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
  { timeout: 180_000 },
);

test(
  'postgres: OM_PG_CONNECTION_STRING parsing variants',
  async () => {
    if (process.env.OM_METADATA_BACKEND !== 'postgres') {
      if (process.env.TEST_DEBUG === '1')
        console.log(
          'Skipping Postgres tests (OM_METADATA_BACKEND != postgres)',
        );
      return;
    }

    // Test various connection string formats and sslmode behaviors
    const testCases = [
      {
        name: 'sslmode=require should create TLS connection',
        connStr: 'postgres://user:password@host:5432/db?sslmode=require',
        expectedOpts: {
          host: 'host',
          port: 5432,
          user: 'user',
          password: 'password',
          database: 'db',
        },
        expectedSsl: { rejectUnauthorized: false },
      },
      {
        name: 'sslmode=disable should use insecure connection',
        connStr: 'postgres://user:pass@host/db?sslmode=disable',
        expectedOpts: {
          host: 'host',
          port: undefined,
          user: 'user',
          password: 'pass',
          database: 'db',
        },
        expectedSsl: false,
      },
      {
        name: 'sslmode=verify-full should enable strict SSL verification',
        connStr: 'postgres://user:pass@host/db?sslmode=verify-full',
        expectedOpts: {
          host: 'host',
          port: undefined,
          user: 'user',
          password: 'pass',
          database: 'db',
        },
        expectedSsl: { rejectUnauthorized: true },
      },
      {
        name: 'missing port should default to undefined',
        connStr: 'postgres://user:pass@host/db',
        expectedOpts: {
          host: 'host',
          port: undefined,
          user: 'user',
          password: 'pass',
          database: 'db',
        },
        expectedSsl: undefined,
      },
      {
        name: 'URL-encoded username and password should be decoded',
        connStr: 'postgres://user%40domain:pa%26%2Bword@host:5432/db%2Ftest',
        expectedOpts: {
          host: 'host',
          port: 5432,
          user: 'user@domain',
          password: 'pa&+word',
          database: 'db/test',
        },
        expectedSsl: undefined,
      },
    ];

    for (const testCase of testCases) {
      test(testCase.name, async () => {
        // Save original env and globals
        const originalEnv = process.env;
        const originalEnvPgConnectionString =
          process.env.OM_PG_CONNECTION_STRING;
        const originalBun = (globalThis as any).Bun;
        try {
          // Set up test environment
          process.env.OM_METADATA_BACKEND = 'postgres';
          process.env.OM_PG_CONNECTION_STRING = testCase.connStr;
          process.env.OM_ENABLE_PG = 'true';
          // Clear individual PG env vars to test fallback
          delete process.env.OM_PG_HOST;
          delete process.env.OM_PG_PORT;
          delete process.env.OM_PG_USER;
          delete process.env.OM_PG_PASSWORD;
          delete process.env.OM_PG_DB;
          delete process.env.OM_PG_SSL;

          // Mock the postgres client imports to capture connection opts
          let capturedOpts: any = null;
          let capturedClientMock: any = null;

          // Mock globalThis.Bun if not present (for Node/Bun compatibility)
          (globalThis as any).Bun = {
            connectPostgres: (opts: any) => {
              capturedOpts = opts;
              // Return a mock client that implements the minimal interface
              return {
                query: async () => '',
                close: async () => {},
                end: async () => {},
              };
            },
          };

          const mod = await import('../../backend/src/core/db.ts');
          const { initDb, closeDb } = mod as any;

          try {
            // Reset module internal state
            (mod as any)._initialized_db_path = null;

            // Initialize DB - this should parse our connection string
            await initDb();

            // Verify the captured options match expectations
            if (capturedOpts) {
              // Check basic connection parameters
              expect(capturedOpts.host).toBe(testCase.expectedOpts.host);
              expect(capturedOpts.port).toBe(testCase.expectedOpts.port);
              expect(capturedOpts.user).toBe(testCase.expectedOpts.user);
              expect(capturedOpts.password).toBe(
                testCase.expectedOpts.password,
              );
              expect(capturedOpts.database).toBe(
                testCase.expectedOpts.database,
              );

              // Check SSL configuration based on sslmode
              if (testCase.expectedSsl === false) {
                expect(capturedOpts.ssl).toBe(false);
              } else if (
                testCase.expectedSsl &&
                typeof testCase.expectedSsl === 'object'
              ) {
                expect(capturedOpts.ssl).toBeDefined();
                expect((capturedOpts.ssl as any).rejectUnauthorized).toBe(
                  testCase.expectedSsl.rejectUnauthorized,
                );
              } else {
                expect(capturedOpts.ssl).toBeUndefined();
              }
            } else {
              throw new Error(
                'Expected postgres client to be initialized with connection string',
              );
            }
          } finally {
            // Clean up test state
            if (typeof closeDb === 'function') {
              try {
                await closeDb();
              } catch (e) {
                /* ignore */
              }
            }
            // Reset module state to avoid interference
            (mod as any)._initialized_db_path = null;
            (mod as any)._pgClient = null;
          }
        } finally {
          // Restore original environment and globals
          process.env = originalEnv;
          process.env.OM_PG_CONNECTION_STRING = originalEnvPgConnectionString;
          (globalThis as any).Bun = originalBun;
        }
      });
    }
  },
  { timeout: 120_000 },
);

test(
  'postgres: invalid OM_PG_CONNECTION_STRING falls back to env vars',
  async () => {
    if (process.env.OM_METADATA_BACKEND !== 'postgres') {
      if (process.env.TEST_DEBUG === '1')
        console.log(
          'Skipping Postgres tests (OM_METADATA_BACKEND != postgres)',
        );
      return;
    }

    // Save original env and globals
    const originalEnv = process.env;
    const originalEnvPgConnectionString = process.env.OM_PG_CONNECTION_STRING;
    const originalBun = (globalThis as any).Bun;

    try {
      // Set up test with invalid connection string
      process.env.OM_METADATA_BACKEND = 'postgres';
      process.env.OM_PG_CONNECTION_STRING = 'invalid-connection-string';
      process.env.OM_ENABLE_PG = 'true';
      process.env.OM_PG_HOST = 'fallback-host';
      process.env.OM_PG_USER = 'fallback-user';
      process.env.OM_PG_PASSWORD = 'fallback-pass';
      process.env.OM_PG_DB = 'fallback-db';
      process.env.OM_PG_SSL = 'require';

      // Mock to capture the fallback behavior
      let capturedOpts: any = null;
      (globalThis as any).Bun = {
        connectPostgres: (opts: any) => {
          capturedOpts = opts;
          return {
            query: async () => '',
            close: async () => {},
            end: async () => {},
          };
        },
      };

      const mod = await import('../../backend/src/core/db.ts');
      const { initDb, closeDb } = mod as any;

      try {
        // Reset module state
        (mod as any)._initialized_db_path = null;
        (mod as any)._pgClient = null;

        // Initialize DB - should fall back to individual OM_PG_* variables
        await initDb();

        // Verify fallback options were used
        if (capturedOpts) {
          expect(capturedOpts.host).toBe('fallback-host');
          expect(capturedOpts.user).toBe('fallback-user');
          expect(capturedOpts.password).toBe('fallback-pass');
          expect(capturedOpts.database).toBe('fallback-db');
          expect(capturedOpts.ssl).toBeDefined();
          expect(capturedOpts.ssl.rejectUnauthorized).toBe(false); // require sslmode
        } else {
          throw new Error('Expected postgres client to fall back to env vars');
        }
      } finally {
        if (typeof closeDb === 'function') {
          try {
            await closeDb();
          } catch (e) {
            /* ignore */
          }
        }
        // Reset module state
        (mod as any)._initialized_db_path = null;
      }
    } finally {
      // Restore original environment and globals
      process.env = originalEnv;
      process.env.OM_PG_CONNECTION_STRING = originalEnvPgConnectionString;
      (globalThis as any).Bun = originalBun;
    }
  },
  { timeout: 120_000 },
);
