import fs from 'fs';
import path from 'path';
import { test, expect } from 'bun:test';

// Prevent auto-start and ensure cfg/env uses our overrides
process.env.OM_NO_AUTO_START = 'true';
process.env.OM_METADATA_BACKEND = 'sqlite';

test('initDb() is idempotent across DB paths', async () => {
  const tmpDir = path.resolve(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const dbPath1 = path.join(
    tmpDir,
    `openmemory-initdb-${process.pid}-1.sqlite`,
  );
  const dbPath2 = path.join(
    tmpDir,
    `openmemory-initdb-${process.pid}-2.sqlite`,
  );

  // Ensure any previous artifacts removed
  try {
    fs.unlinkSync(dbPath1);
  } catch (e) {}
  try {
    fs.unlinkSync(dbPath2);
  } catch (e) {}

  // First initialization: set process.env before importing so cfg picks it up
  process.env.OM_DB_PATH = dbPath1;
  const mod = await import('../../backend/src/core/db.ts');
  const { initDb } = mod as any;
  const cfg = await import('../../backend/src/core/cfg.ts');

  // First call should create DB file
  await initDb();
  expect(fs.existsSync(dbPath1)).toBe(true);

  // Now update env/db_path in the parsed config and re-run initDb for a different path
  (cfg as any).env.db_path = dbPath2;
  process.env.OM_DB_PATH = dbPath2;

  await initDb();
  expect(fs.existsSync(dbPath2)).toBe(true);
  // Close DB handles used during this test
  try {
    const mod = await import('../../backend/src/core/db.ts');
    if (mod && typeof (mod as any).closeDb === 'function')
      await (mod as any).closeDb();
  } catch (e) {}
});
