import fs from "fs";
import path from "path";
import os from "os";

// Ensure each test run uses an isolated temporary sqlite DB to avoid locks and cross-test interference
const tmpDir = path.resolve(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
process.env.OM_DB_PATH = path.join(tmpDir, `openmemory-test-${process.pid}-${Date.now()}.sqlite`);

import { describe, test, expect, beforeEach } from "bun:test";
import { initDb, q, transaction } from "../../backend/src/core/db";
import { env } from "../../backend/src/core/cfg";

// This test suite validates the database layer, running tests for both
// SQLite and PostgreSQL if configured.

const is_pg = env.metadata_backend === "postgres";

describe(`Database Layer (${is_pg ? 'PostgreSQL' : 'SQLite'})`, () => {
    beforeEach(async () => {
        // For SQLite, the initDb in the server will handle in-memory.
        // For Postgres, we might need a more complex setup if we were to drop tables,
        // but for these tests, we'll just ensure data isolation via user_id.
        if (!is_pg) {
            // Re-initialize the database for each test to ensure isolation for SQLite.
            await initDb();
        }
    });

    test("should insert and retrieve a user", async () => {
        const userId = `test-user-${Date.now()}`;
        const now = Date.now();

        await transaction.begin();
        await q.ins_user.run(userId, "initial summary", 0, now, now);
        await transaction.commit();

        const user: any = await q.get_user.get(userId);

        expect(user).not.toBeNull();
        expect(user.user_id).toBe(userId);
        expect(user.summary).toBe("initial summary");
    });

    test("should maintain multi-tenant data isolation", async () => {
        const userId1 = `iso-user-1-${Date.now()}`;
        const userId2 = `iso-user-2-${Date.now()}`;
        const now = Date.now();

        await transaction.begin();
        // Insert memories for two different users
        await q.ins_mem.run(`mem1-${now}`, userId1, 0, "content1", `sim1-${now}`, "episodic", null, null, now, now, now, 1, 0.99, 1, null, null, null, 0);
        await q.ins_mem.run(`mem2-${now}`, userId2, 0, "content2", `sim2-${now}`, "episodic", null, null, now, now, now, 1, 0.99, 1, null, null, null, 0);
        await transaction.commit();

        // Fetch memories for each user
        const user1Mems = await q.all_mem_by_user.all(userId1, 10, 0);
        const user2Mems = await q.all_mem_by_user.all(userId2, 10, 0);

        // Verify that each user only sees their own data
        expect(user1Mems).toHaveLength(1);
        expect(user1Mems[0].content).toBe("content1");

        expect(user2Mems).toHaveLength(1);
        expect(user2Mems[0].content).toBe("content2");
    });

    test("transaction should rollback on error", async () => {
        const userId = `rollback-user-${Date.now()}`;
        try {
            await transaction.begin();
            await q.ins_user.run(userId, "this should not be committed", 0, Date.now(), Date.now());
            // Force an error to trigger rollback
            throw new Error("Test rollback");
        } catch (e: any) {
            if (e.message === "Test rollback") {
                await transaction.rollback();
            } else {
                // If another error occurred, re-throw it
                throw e;
            }
        }

        const user = await q.get_user.get(userId);
        // Depending on the driver/library this may be `null` or `undefined` when not found.
        expect(user == null).toBe(true);
    });
});
