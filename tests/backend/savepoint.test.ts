import fs from "fs";
import path from "path";
import os from "os";

// Use isolated temporary DB for this test to avoid interference with other suites
const tmpDir = path.resolve(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
process.env.OM_DB_PATH = path.join(tmpDir, `openmemory-savepoint-${process.pid}-${Date.now()}.sqlite`);

import { describe, test, expect, beforeEach } from "bun:test";
import { initDb, q, transaction } from "../../backend/src/core/db";
import { env } from "../../backend/src/core/cfg";

const is_pg = env.metadata_backend === "postgres";

describe(`Nested transaction / savepoint behavior (${is_pg ? 'Postgres' : 'SQLite'})`, () => {
    beforeEach(async () => {
        // Re-init DB for isolation when using SQLite
        if (!is_pg) await initDb();
    });

    test("nested rollback should only rollback inner savepoint", async () => {
        const uidOuter = `outer-${Date.now()}`;
        const uidInner = `inner-${Date.now()}`;

        await transaction.begin();
        await q.ins_user.run(uidOuter, "outer summary", 0, Date.now(), Date.now());

        // start nested transaction
        await transaction.begin();
        await q.ins_user.run(uidInner, "inner summary", 0, Date.now(), Date.now());

        // rollback inner
        await transaction.rollback();

        // commit outer
        await transaction.commit();

        const outer = await q.get_user.get(uidOuter);
        const inner = await q.get_user.get(uidInner);

        expect(outer).not.toBeNull();
        expect(outer.user_id).toBe(uidOuter);
        // inner should have been rolled back
        expect(inner == null).toBe(true);
    });

    test("nested commit should persist inner when outer commits", async () => {
        const uidA = `a-${Date.now()}`;
        const uidB = `b-${Date.now()}`;

        await transaction.begin();
        await q.ins_user.run(uidA, "a summary", 0, Date.now(), Date.now());

        await transaction.begin();
        await q.ins_user.run(uidB, "b summary", 0, Date.now(), Date.now());
        // commit inner savepoint
        await transaction.commit();

        // commit outer
        await transaction.commit();

        const a = await q.get_user.get(uidA);
        const b = await q.get_user.get(uidB);

        expect(a).not.toBeNull();
        expect(a.user_id).toBe(uidA);
        expect(b).not.toBeNull();
        expect(b.user_id).toBe(uidB);
    });
});
