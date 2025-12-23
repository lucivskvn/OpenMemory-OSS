import { describe, test, expect, beforeAll } from "bun:test";
import { transaction, q, all_async } from "../../src/core/db";

describe('Transaction Safety', () => {
    test('Nested Transactions (Depth Counting)', async () => {
        const id = "tx-test-" + Date.now();
        const id2 = "tx-test-2-" + Date.now();

        await transaction.begin(); // Depth 1
        try {
            await q.ins_user.run(id, "User 1", 0, Date.now(), Date.now());

            await transaction.begin(); // Depth 2
            try {
                await q.ins_user.run(id2, "User 2", 0, Date.now(), Date.now());
                await transaction.commit(); // Depth 1
            } catch (e) {
                await transaction.rollback();
                throw e;
            }

            await transaction.commit(); // Depth 0 (Real Commit)
        } catch (e) {
            await transaction.rollback();
            throw e;
        }

        // Verify both exist
        const u1 = await q.get_user.get(id);
        const u2 = await q.get_user.get(id2);
        expect(u1).toBeDefined();
        expect(u2).toBeDefined();
    });

    test('Rollback in Nested Transaction', async () => {
        const id = "tx-rollback-" + Date.now();
        const id2 = "tx-rollback-2-" + Date.now();

        try {
            await transaction.begin(); // Depth 1
            await q.ins_user.run(id, "User 1", 0, Date.now(), Date.now());

            try {
                await transaction.begin(); // Depth 2
                await q.ins_user.run(id2, "User 2", 0, Date.now(), Date.now());
                throw new Error("Force Rollback");
            } catch (e) {
                await transaction.rollback(); // Rolls back EVERYTHING
                // In depth counting, this resets depth to 0 and rolls back.
            }
            // If we try to commit here, it might be weird if depth is 0?
            // Or we should expect the outer block to catch/handle it?
            // In my implementation, rollback resets depth to 0.
            // So subsequent commit calls might be no-ops or error?
            // If depth is 0, commit does nothing (or throws if not in tx).
            // SQLite `COMMIT` when not in transaction might be fine or error?
            // My implementation: `if (txDepth === 0) db.run("COMMIT")`.
            // But if we just rolled back, we aren't in transaction.
            // Let's assume the outer block handles flow control.

        } catch (e) {
            // ignore
        }

        // Verify NEITHER exists
        const u1 = await q.get_user.get(id);
        const u2 = await q.get_user.get(id2);
        expect(u1).toBeFalsy();
        expect(u2).toBeFalsy();
    });
});
