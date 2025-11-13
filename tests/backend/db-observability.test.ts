import fs from "fs";
import path from "path";

// Use isolated tmp DB for observability tests
const tmpDir = path.resolve(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
process.env.OM_DB_PATH = path.join(tmpDir, `openmemory-observe-${process.pid}-${Date.now()}.sqlite`);

import { describe, beforeEach, test, expect } from "bun:test";
import { initDb, q, transaction } from "../../backend/src/core/db";

// Enable observability flags for tests
process.env.OM_DB_USER_SCOPE_WARN = "true";
process.env.OM_DB_LOG = "true";
process.env.OM_DB_SLOW_MS = "0"; // make all queries eligible for slow logging in tests

describe("DB Observability Wrappers", () => {
    beforeEach(async () => {
        await initDb();
    });

    test("wrapped helpers work and do not throw on unscoped queries", async () => {
        // Insert a user and a memory scoped to that user
        const userId = `obs-user-${Date.now()}`;
        const now = Date.now();

        await transaction.begin();
        await q.ins_user.run(userId, "summary", 0, now, now);
        await q.ins_mem.run(`m-${now}`, userId, 0, "observed content", `s-${now}`, "test", null, null, now, now, now, 1, 0.5, 1, null, null, null, 0);
        await transaction.commit();

        // Fetch by id
        const mem = await q.get_mem.get(`m-${now}`);
        expect(mem).not.toBeNull();
        expect(mem.content).toBe("observed content");

        // Call an unscoped query (all_mem) which should trigger a warning but not throw
        const rows = await q.all_mem.all(10, 0);
        expect(Array.isArray(rows)).toBe(true);
    });
});
