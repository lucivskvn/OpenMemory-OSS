
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { q, runAsync, closeDb, allAsync } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { env } from "../../src/core/cfg";
import { TABLES } from "../../src/core/db";
import fs from "node:fs";
import path from "node:path";

describe("DB Isolation & Integrity", () => {
    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
        process.env.OM_DB_PATH = path.resolve(process.cwd(), "test_db_isolation.sqlite");
        reloadConfig();
        console.log("[TEST DEBUG] Env dbPath:", env.dbPath);

        // Reset DB connection to ensure we use the new path
        await closeDb();

        // Setup clean state (safe now as it is a new DB file)
        await q.clearAll.run();

        // Insert test data
        await q.insMem.run("sys-1", "System content", "episodic", null, null, null, 0, "sim1", 100, 100, 100, 1.0, 0, 1, 0, Buffer.alloc(0), Buffer.alloc(0), 0, null);
        await q.insMem.run("usera-1", "User A content", "episodic", null, null, "user-a", 0, "sim2", 200, 200, 200, 1.0, 0, 1, 0, Buffer.alloc(0), Buffer.alloc(0), 0, null);
        await q.insMem.run("userb-1", "User B content", "episodic", null, null, "user-b", 0, "sim3", 300, 300, 300, 1.0, 0, 1, 0, Buffer.alloc(0), Buffer.alloc(0), 0, null);

        const count = await q.getMemCount.get(undefined);
        console.log("[TEST DEBUG] Count after insert:", count?.c);
    });

    afterAll(async () => {
        await closeDb();
        const dbPath = path.resolve(process.cwd(), "test_db_isolation.sqlite");
        if (fs.existsSync(dbPath)) {
            try {
                fs.unlinkSync(dbPath);
            } catch (e) {
                // Ignore EBUSY on Windows during test
            }
        }
    });

    test("System Query (null) should only return System rows", async () => {
        const mems = await q.allMem.all(10, 0, null);
        expect(mems.length).toBe(1);
        expect(mems[0].id).toBe("sys-1");
    });

    test("Tenant Query (string) should only return Tenant rows", async () => {
        const memsA = await q.allMem.all(10, 0, "user-a");
        expect(memsA.length).toBe(1);
        expect(memsA[0].id).toBe("usera-1");

        const memsB = await q.allMem.all(10, 0, "user-b");
        expect(memsB.length).toBe(1);
        expect(memsB[0].id).toBe("userb-1");
    });

    test("Global Query (undefined) should return ALL rows", async () => {
        const allMems = await q.allMem.all(10, 0, undefined);
        expect(allMems.length).toBe(3);
        const ids = allMems.map((m: any) => m.id).sort();
        expect(ids).toEqual(["sys-1", "usera-1", "userb-1"]);
    });

    test("Specific Getter Isolation", async () => {
        const leak = await q.getMem.get("userb-1", "user-a");
        expect(leak).toBeUndefined();

        const valid = await q.getMem.get("usera-1", "user-a");
        expect(valid).toBeDefined();
        expect(valid?.id).toBe("usera-1");

        const sys = await q.getMem.get("sys-1", null);
        expect(sys).toBeDefined();
        expect(sys?.id).toBe("sys-1");

        const sysLeak = await q.getMem.get("usera-1", null);
        expect(sysLeak).toBeUndefined();
    });

    // "Helper: sqlUser logic check" removed - covered by unit tests in db_utils.test.ts
});
