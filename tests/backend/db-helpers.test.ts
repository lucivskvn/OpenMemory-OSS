import fs from "fs";
import path from "path";
import { test, expect } from "bun:test";

process.env.OM_NO_AUTO_START = "true";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_EMBED_KIND = "synthetic";
// Disable noisy DB user-scope warnings for tests that import the DB helpers directly.
process.env.OM_DB_USER_SCOPE_WARN = process.env.OM_DB_USER_SCOPE_WARN || "false";

test("db helpers: ins_mem/ins_vec/get_vec/get_user and transactions", async () => {
    const tmpDir = path.resolve(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const dbPath = path.join(tmpDir, `openmemory-dbtest-${process.pid}.sqlite`);
    try { fs.unlinkSync(dbPath); } catch (e) { }

    process.env.OM_DB_PATH = dbPath;
    const dbMod: any = await import("../../backend/src/core/db.ts");
    const { initDb, q, transaction } = dbMod;

    await initDb();
    expect(fs.existsSync(dbPath)).toBe(true);

    const now = Date.now();
    const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Legacy-order parameters will be mapped by ins_mem implementation
    // canonical 18-arg form so user_id is explicit (null here means intentionally unscoped)
    await q.ins_mem.run(
        id,
            null,
            0,
            "this is a test",
            "",
            "semantic",
            JSON.stringify([]),
            JSON.stringify({}),
            now,
            now,
            now,
            1.0,
            0.0,
            1,
            0,
            Buffer.alloc(0),
            Buffer.alloc(0),
            0,
        );

    // Insert a vector (zero-filled) for this id
    const cfg = await import("../../backend/src/core/cfg.ts");
    const dim = cfg.env.vec_dim || 256;
    const buf = Buffer.from(new Float32Array(dim).buffer);
    await q.ins_vec.run(id, "semantic", "user1", buf, dim);

    const vecRow = await q.get_vec.get(id, "semantic", "user1");
    expect(vecRow).toBeDefined();
    // Support row shapes: object or array-like
    expect(vecRow.dim || vecRow["dim"]).toBe(dim);

    // ins_user / get_user
    await q.ins_user.run("user1", "summary", 0, Date.now(), Date.now());
    const u = await q.get_user.get("user1");
    expect(u).toBeDefined();
    expect(u.user_id || u["user_id"]).toBe("user1");

    // Transactions: begin -> insert -> rollback should not persist
    const txmem = `m-tx-${Date.now()}`;
    await transaction.begin();
    await q.ins_mem.run(
        txmem,
        "user1",
        0,
        "temp payload",
        "",
        "semantic",
        JSON.stringify([]),
        JSON.stringify({}),
        now,
        now,
        now,
        1.0,
        0.0,
        1,
        0,
        Buffer.alloc(0),
        Buffer.alloc(0),
        0,
    );
    await transaction.rollback();
    const after = await q.get_mem.get(txmem, null);
    // SQLite `.get` returns `null` when no row is found; accept null or undefined
    expect(after == null).toBe(true);

    // Now test commit
    const txId = `tx-${Date.now()}`;
    await transaction.begin();
    // explicit user1 as user_id in canonical form
    await q.ins_mem.run(
        txId,
            "user1",
            0,
            "committed payload",
            "",
            "semantic",
            JSON.stringify([]),
            JSON.stringify({}),
            now,
            now,
            now,
            1.0,
            0.0,
            1,
            0,
            Buffer.alloc(0),
            Buffer.alloc(0),
            0,
        );
    await transaction.commit();
    const got = await q.get_mem.get(txId, null);
    expect(got).toBeDefined();
    expect(got.id || got["id"]).toBe(txId);
});
