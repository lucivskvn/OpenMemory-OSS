import { describe, expect, it, test, beforeAll, afterAll } from "bun:test";
import { waitForDb, closeDb, q, runAsync } from "../../src/core/db";
import { env } from "../../src/core/cfg";
import { TABLES } from "../../src/core/db_access";

describe("Phase1 Core Infrastructure", () => {
    beforeAll(async () => {
        Bun.env.OM_SKIP_GLOBAL_SETUP = "true";
        Bun.env.OM_DB_PATH = ":memory:";
        await waitForDb();
    });

    afterAll(async () => {
        await closeDb();
    });

    describe("Database Operations", () => {
        test("should initialize all required tables", async () => {
            const tables = await q.getTables.all();
            const expected = [
                "memories", "users", "stats", "temporal_facts", "api_keys", "config"
            ];
            const names = tables.map((t: any) => t.name);
            for (const t of expected) {
                expect(names.some((n: string) => n.includes(t))).toBe(true);
            }
        });

        test("should perform basic inserts and queries", async () => {
            await q.insUser.run("test-user", "", 0, Date.now(), Date.now());
            const user = await q.getUser.get("test-user");
            expect(user).toBeDefined();
            expect(user.userId).toBe("test-user");
        });

        test("should handle transaction rollbacks correctly", async () => {
            const startCount = (await q.getUsers.all()).length;
            try {
                await q.transaction.run(async () => {
                    await q.insUser.run("rollback-user", "", 0, Date.now(), Date.now());
                    throw new Error("Force Rollback");
                });
            } catch (e) {
                // Expected rollback
            }
            const endCount = (await q.getUsers.all()).length;
            expect(endCount).toBe(startCount);
        });

        test("should handle helper functions like runAsync", async () => {
            await runAsync(`INSERT INTO ${TABLES.users} (user_id) VALUES (?)`, ["manual-user"]);
            const res = await q.getUser.get("manual-user");
            expect(res).toBeDefined();
        });
    });
});
