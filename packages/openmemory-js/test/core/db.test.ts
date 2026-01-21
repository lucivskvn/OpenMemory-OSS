import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { waitForDb, closeDb, q, runAsync } from "../../src/core/db";
import { env } from "../../src/core/cfg";
import { TABLES } from "../../src/core/db_access";

describe("Core DB Infrastructure", () => {
    beforeAll(async () => {
        env.dbPath = ":memory:";
        await waitForDb();
    });

    afterAll(async () => {
        await closeDb();
    });

    it("should initialize all tables", async () => {
        const tables = await q.getTables.all();
        const expected = [
            "memories", "users", "stats", "temporal_facts", "api_keys", "config"
        ];
        const names = tables.map((t: any) => t.name);
        for (const t of expected) {
            // We configured TABLES proxy, so the actual name might match simple case in sqlite
            // In :memory: sqlite, names should be simple.
            // We can check if *some* name contains our expected string
            expect(names.some((n: string) => n.includes(t))).toBe(true);
        }
    });

    it("should perform basic inserts and queries", async () => {
        await q.insUser.run("test-user", "", 0, Date.now(), Date.now());
        const user = await q.getUser.get("test-user");
        expect(user).toBeDefined();
        expect(user.userId).toBe("test-user");
    });

    it("should handle transaction rollbacks", async () => {
        const startCount = (await q.getUsers.all()).length;
        try {
            await q.transaction.run(async () => {
                await q.insUser.run("rollback-user", "", 0, Date.now(), Date.now());
                throw new Error("Force Rollback");
            });
        } catch (e) {
            // Expected
        }
        const endCount = (await q.getUsers.all()).length;
        expect(endCount).toBe(startCount);
    });

    it("should handle helper functions like runAsync", async () => {
        await runAsync(`INSERT INTO ${TABLES.users} (user_id) VALUES (?)`, ["manual-user"]);
        const res = await q.getUser.get("manual-user");
        expect(res).toBeDefined();
    });
});
