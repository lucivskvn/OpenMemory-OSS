import { test, expect } from "bun:test";
import crypto from "crypto";

async function waitFor(predicate: () => Promise<boolean>, attempts = 40, delayMs = 250) {
    for (let i = 0; i < attempts; i++) {
        try {
            if (await predicate()) return true;
        } catch (e) { }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
}

test("postgres q parity: placeholders, ordering, null handling", async () => {
    if (process.env.OM_METADATA_BACKEND !== "postgres") return;

    process.env.OM_NO_AUTO_START = "true";
    const mod = await import("../../backend/src/core/db.ts");
    const { initDb } = mod as any;

    await initDb();

    try {
        const ready = await waitFor(async () => {
        try {
            if (!mod.memories_table) return false;
            await (mod.get_async)(`select 1 as v`);
            return true;
        } catch (e) {
            return false;
        }
    }, 80, 250);

    expect(ready).toBe(true);

    const run = mod.run_async;
    const get = mod.get_async;
    const all = mod.all_async;
    const memTable = mod.memories_table;

    // Clean up any previous rows from earlier runs
    await run(`delete from ${memTable} where primary_sector = $1`, ["pg-q-parity"]);

    // Test placeholder reuse and ordering: same parameter used multiple times
    const testId = crypto.randomUUID();
    const now = Date.now();
    await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
        [testId, "pg-q-user", "parity-content", "pg-q-parity", now, now],
    );

    // Reuse same parameter in select
    const row = await get(`select $1 as a, $1 as b, $2 as id`, ["reused", testId]);
    expect(row.a).toBe("reused");
    expect(row.b).toBe("reused");
    expect(row.id).toBe(testId);

    // Test IN-list placeholder ordering with multiple params
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
        [idA, "pg-q-user", "in-a", "pg-q-parity", now, now],
    );
    await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`,
        [idB, "pg-q-user", "in-b", "pg-q-parity", now, now],
    );

    const inRows = await all(`select id,content from ${memTable} where id in ($1,$2) order by id`, [idA, idB]);
    const ids = inRows.map((r: any) => r.id).sort();
    expect(ids).toEqual([idA, idB].sort());

    // Null handling: the pattern (? is null or user_id = ?) should accept null and not error
    // Use the pattern with Postgres placeholders
    const nullRows = await all(
        `select * from ${memTable} where ($1 is null or user_id = $1) limit 1`,
        [null],
    );
    // Should return at least one row (we inserted above)
    expect(nullRows.length).toBeGreaterThanOrEqual(1);

        // Cleanup
        await run(`delete from ${memTable} where primary_sector = $1`, ["pg-q-parity"]);
        await run(`delete from ${memTable} where id in ($1,$2,$3)`, [testId, idA, idB]);
    } finally {
        if (mod && typeof (mod as any).closeDb === 'function') {
            try { await (mod as any).closeDb(); } catch (e) { /* best-effort */ }
        }
    }
}, { timeout: 120_000 });
