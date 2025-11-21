import fs from 'fs';
import path from 'path';

// Use a per-run temporary database file to avoid DB locks
const tmpDir = path.resolve(process.cwd(), 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
process.env.OM_DB_PATH = path.join(
  tmpDir,
  `openmemory-mkroot-${process.pid}-${Date.now()}.sqlite`,
);

import { test, expect, beforeAll, afterAll } from 'bun:test';
import {
  initDb,
  q,
  transaction,
  closeDb,
} from '../../backend/src/core/db.test-entry';

// Disable user-scope warn in most tests to keep logs focused; mkroot relies on explicit user_id in calls.
process.env.OM_DB_USER_SCOPE_WARN =
  process.env.OM_DB_USER_SCOPE_WARN || 'false';

beforeAll(async () => {
  await initDb();
});

afterAll(async () => {
  try {
    await closeDb();
  } catch (e) {}
});

test('legacy ins_mem parameter order creates a memory row', async () => {
  const id = `test-mkroot-${Date.now()}`;
  const content = 'This is a legacy-order test content.';
  const primary_sector = 'reflective';
  const tags = JSON.stringify([]);
  const meta = JSON.stringify({ test: true });
  const ts = Date.now();

  await transaction.begin();
  // Call ins_mem with the legacy caller parameter ordering (as used by mkRoot)
  await q.ins_mem.run(
    id,
    content,
    primary_sector,
    tags,
    meta,
    ts,
    ts,
    ts,
    1.0,
    0.1,
    1,
    'test-user',
    null,
  );
  await transaction.commit();

  const row: any = await q.get_mem.get(id, null);
  expect(row).not.toBeNull();
  expect(row.id).toBe(id);
  expect(row.primary_sector).toBe(primary_sector);
  expect(row.user_id).toBe('test-user');
});
