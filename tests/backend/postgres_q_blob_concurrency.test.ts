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

test("postgres q blob/array/concurrency: binary bindings, array+scalar mix, high-concurrency reuse", async () => {
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

    // --- Binary/blob binding test ---
    const idBlob = crypto.randomUUID();
    // 2MiB buffer to exercise binary binding and large payload handling
    const buf = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const now = Date.now();
    // Insert into the `compressed_vec` column (schema includes this column)
    await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,compressed_vec,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7)`,
        [idBlob, "pg-blob", "blob-test", "pg-blob-parity", buf, now, now],
    );

    const gotBlob = await get(`select compressed_vec from ${memTable} where id=$1`, [idBlob]);
    // Some drivers return Buffer, some return Uint8Array or base64 string — handle common cases
    let receivedLength = -1;
    if (!gotBlob) {
        throw new Error("Expected blob row");
    }
    if (Buffer.isBuffer(gotBlob.compressed_vec)) {
        receivedLength = gotBlob.compressed_vec.length;
    } else if (gotBlob.compressed_vec instanceof Uint8Array) {
        receivedLength = gotBlob.compressed_vec.byteLength;
    } else if (typeof gotBlob.compressed_vec === "string") {
        // base64 encoded
        receivedLength = Buffer.from(gotBlob.compressed_vec, "base64").length;
    }
    expect(receivedLength).toBe(buf.length);

    // --- Array + scalar mixing test (jsonb containment with scalar param) ---
    const idArray = crypto.randomUUID();
    const tags = ["alpha", "beta"];
    await run(
        `insert into ${memTable}(id,user_id,content,primary_sector,tags,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7)`,
        [idArray, "pg-arr", "arr-test", "pg-adv", JSON.stringify(tags), now, now],
    );

    // Query mixing a JSON array param and a scalar param in the same prepared statement
    const rows = await all(`select id from ${memTable} where tags::jsonb @> $1::jsonb and user_id = $2`, [JSON.stringify(["alpha"]), "pg-arr"]);
    expect(rows.some((r: any) => r.id === idArray)).toBe(true);

    // --- High-concurrency prepared-statement reuse test ---
    const concurrency = 64;
    const ids: string[] = [];
    for (let i = 0; i < concurrency; i++) ids.push(crypto.randomUUID());

    // Fire many parallel inserts using the same parameterized SQL to ensure driver/pg pool reuses prepared statements safely
    await Promise.all(ids.map((iid) => run(`insert into ${memTable}(id,user_id,content,primary_sector,created_at,updated_at) values($1,$2,$3,$4,$5,$6)`, [iid, "pg-conc", "concurrent", "pg-conc", Date.now(), Date.now()])));

    const found = await all(`select id from ${memTable} where user_id = $1 and content = $2`, ["pg-conc", "concurrent"]);
    // Expect at least `concurrency` rows present (allow for small timing variance)
    expect(found.length).toBeGreaterThanOrEqual(concurrency);

        // Cleanup inserted rows
        await run(`delete from ${memTable} where primary_sector in ($1,$2,$3)`, ["pg-blob-parity", "pg-adv", "pg-conc"]);
        await run(`delete from ${memTable} where id in ($1,$2,$3)`, [idBlob, idArray, ids[0]]);
    } finally {
        if (mod && typeof (mod as any).closeDb === 'function') {
            try { await (mod as any).closeDb(); } catch (e) { /* best-effort */ }
        }
    }
}, { timeout: 240_000 });
