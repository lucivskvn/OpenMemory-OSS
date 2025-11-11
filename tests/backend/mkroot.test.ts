import fs from "fs";
import path from "path";

// Use a per-run temporary database file to avoid DB locks
const tmpDir = path.resolve(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
process.env.OM_DB_PATH = path.join(tmpDir, `openmemory-mkroot-${process.pid}-${Date.now()}.sqlite`);

import { test, expect, beforeAll } from "bun:test";
import { initDb, q, transaction } from "../../backend/src/core/db";

beforeAll(() => {
    initDb();
});

test("legacy ins_mem parameter order creates a memory row", async () => {
    const id = `test-mkroot-${Date.now()}`;
    const content = "This is a legacy-order test content.";
    const primary_sector = "reflective";
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
        "test-user",
        null,
    );
    await transaction.commit();

    const row: any = await q.get_mem.get(id);
    expect(row).not.toBeNull();
    expect(row.id).toBe(id);
    expect(row.primary_sector).toBe(primary_sector);
    expect(row.user_id).toBe("test-user");
});
