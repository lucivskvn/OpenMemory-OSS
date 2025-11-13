import { describe, it, expect } from "bun:test";
import path from "path";
import { initDb, q, transaction } from "../../backend/src/core/db";
import { run_migrations } from "../../backend/src/migrate";

describe("migrations and DB helpers", () => {
    it("runs migrations successfully against a temp DB and exercises q helpers", async () => {
        const tmpDb = path.resolve(process.cwd(), "tmp", "test-migrate.sqlite");
        // Ensure the migration runner uses the tmp DB path
        process.env.OM_DB_PATH = tmpDb;
        process.env.OM_METADATA_BACKEND = "sqlite";
        try {
            await run_migrations();
        } catch (e) {
            throw e;
        }

        // Now initialize an in-memory DB to test helpers in isolation
        process.env.OM_DB_PATH = ":memory:";
        await initDb();

        // Insert a memory using legacy short-arg form
        const id = "test-mem-1";
        const now = Date.now();
        await q.ins_mem.run(id, "hello world", "semantic", "", "{}", now, now, now, 1.0, 0.0, 1, "user1");
        const got = await q.get_mem.get(id);
        expect(got).toBeTruthy();
        expect(got.user_id).toBe("user1");

        // Transaction commit/rollback behavior for vectors
        const vid = "vec-1";
        await transaction.begin();
        try {
            await q.ins_vec.run(vid, "semantic", "user1", Buffer.from([0, 1, 2, 3]), 1);
            await transaction.commit();
        } catch (e) {
            await transaction.rollback();
            throw e;
        }
        const vrow = await q.get_vec.get(vid, "semantic");
        expect(vrow).toBeTruthy();

        // Rollback path
        await transaction.begin();
        try {
            await q.ins_vec.run("vec-rollback", "semantic", "user1", Buffer.from([1, 2, 3, 4]), 1);
            throw new Error("force-rollback");
        } catch (e) {
            await transaction.rollback();
        }
        const rb = await q.get_vec.get("vec-rollback", "semantic");
        expect(rb === null || rb === undefined).toBe(true);

        // Multi-tenant isolation
        await q.ins_mem.run("m2", "user two", "semantic", "", "{}", now, now, now, 1.0, 0.0, 1, "user2");
        const user1Rows = await q.all_mem_by_user.all("user1", 10, 0);
        expect(Array.isArray(user1Rows)).toBe(true);
        expect(user1Rows.every((r: any) => r.user_id === "user1")).toBe(true);

        // Insert vectors for both tenants and verify scoping via get_vec and neighbors
        await q.ins_vec.run("v-u1", "semantic", "user1", Buffer.from(new Float32Array([0.1]).buffer), 1);
        await q.ins_vec.run("v-u2", "semantic", "user2", Buffer.from(new Float32Array([0.2]).buffer), 1);

        // Unscoped get_vec should return the vector row regardless of user when user_id not provided
        const unscoped = await q.get_vec.get("v-u1", "semantic");
        expect(unscoped).toBeTruthy();

        // Scoped get_vec should respect user_id
        const scopedU1 = await q.get_vec.get("v-u1", "semantic", "user1");
        expect(scopedU1).toBeTruthy();
        const scopedWrong = await q.get_vec.get("v-u1", "semantic", "user2");
        expect(scopedWrong === null || scopedWrong === undefined).toBe(true);

        // Waypoints: insert neighbors for user1 and user2 and test filtering
        await q.ins_waypoint.run("src-u1", "dst-u1", "user1", 0.9, Date.now(), Date.now());
        await q.ins_waypoint.run("src-u2", "dst-u2", "user2", 0.8, Date.now(), Date.now());

        const neighUnscoped = await q.get_neighbors.all("src-u1");
        expect(Array.isArray(neighUnscoped)).toBe(true);
        const neighScoped = await q.get_neighbors.all("src-u1", "user1");
        expect(neighScoped.length).toBeGreaterThan(0);
        const neighWrong = await q.get_neighbors.all("src-u1", "user2");
        expect(neighWrong.length).toBe(0);
    });
});
