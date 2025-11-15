import fs from "fs";
import path from "path";

// Use isolated tmp DB for observability tests
const tmpDir = path.resolve(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
process.env.OM_DB_PATH = path.join(tmpDir, `openmemory-observe-${process.pid}-${Date.now()}.sqlite`);

import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import { initDb, q, transaction } from "../../backend/src/core/db";

describe("DB Observability Wrappers", () => {
    let _prev_warn: string | undefined;
    let _prev_log: string | undefined;
    let _prev_slow: string | undefined;

    beforeEach(async () => {
        // Enable observability flags only for this test suite and restore them afterwards
        _prev_warn = process.env.OM_DB_USER_SCOPE_WARN;
        _prev_log = process.env.OM_DB_LOG;
        _prev_slow = process.env.OM_DB_SLOW_MS;
        process.env.OM_DB_USER_SCOPE_WARN = "true";
        process.env.OM_DB_LOG = "true";
        process.env.OM_DB_SLOW_MS = "0"; // make all queries eligible for slow logging in tests
        await initDb();
    });

    afterEach(() => {
        // restore previous environment values so other tests are unaffected
        if (_prev_warn === undefined) delete process.env.OM_DB_USER_SCOPE_WARN; else process.env.OM_DB_USER_SCOPE_WARN = _prev_warn;
        if (_prev_log === undefined) delete process.env.OM_DB_LOG; else process.env.OM_DB_LOG = _prev_log;
        if (_prev_slow === undefined) delete process.env.OM_DB_SLOW_MS; else process.env.OM_DB_SLOW_MS = _prev_slow;
    });

    test("wrapped helpers work and do not throw on unscoped queries", async () => {
        // Insert a user and a memory scoped to that user
        const userId = `obs-user-${Date.now()}`;
        const now = Date.now();

        await transaction.begin();
        await q.ins_user.run(userId, "summary", 0, now, now);
        // Use explicit/canonical ins_mem parameter ordering so user_id is passed unambiguously
        await q.ins_mem.run(
            `m-${now}`,
            userId,
            0,
            "observed content",
            "",
            "test",
            JSON.stringify([]),
            JSON.stringify({}),
            now,
            now,
            now,
            1.0,
            0.5,
            1,
            0,
            Buffer.alloc(0),
            Buffer.alloc(0),
            0,
        );
        await transaction.commit();

        // Fetch by id
        const mem = await q.get_mem.get(`m-${now}`, null);
        expect(mem).not.toBeNull();
        expect(mem.content).toBe("observed content");

        // Call an unscoped query (all_mem) which should trigger a warning but not throw
        const rows = await q.all_mem.all(10, 0);
        expect(Array.isArray(rows)).toBe(true);
    });
});
