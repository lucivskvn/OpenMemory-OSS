import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { usr } from "../../src/server/routes/users";
import { q } from "../../src/core/db";

// Mock DB for user test? Or rely on real DB since it's an integration test.
// We need to create a user first.
// `backend/src/memory/user_summary.ts` creates users.
// Or we can manually insert via `q`.

describe('Users API', () => {
    let app: Elysia;
    const testUserId = "test-user-123";

    beforeAll(async () => {
        app = new Elysia().use(usr);
        // Seed user
        await q.ins_user.run(testUserId, "Test Summary", 5, Date.now(), Date.now());
        // Seed memory
        await q.ins_mem.run(
            "mem-1", testUserId, 0, "Test content", "", "semantic", "[]", "{}",
            Date.now(), Date.now(), Date.now(), 0.5, 0.1, 1, 0, null, null, 0
        );
    });

    test('Get User', async () => {
        const res = await app.handle(new Request(`http://localhost/api/users/${testUserId}`));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.user_id).toBe(testUserId);
        expect(data.summary).toBe("Test Summary");
    });

    test('Get User Summary (Alias)', async () => {
        const res = await app.handle(new Request(`http://localhost/api/users/${testUserId}/summary`));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.user_id).toBe(testUserId);
    });

    test('Get User Memories', async () => {
        const res = await app.handle(new Request(`http://localhost/api/users/${testUserId}/memories`));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data.items)).toBe(true);
        expect(data.items.length).toBeGreaterThan(0);
        expect(data.items[0].id).toBe("mem-1");
    });

    test('Delete User Memories', async () => {
        const res = await app.handle(new Request(`http://localhost/api/users/${testUserId}/memories`, {
            method: 'DELETE'
        }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.deleted).toBeGreaterThan(0);

        // Verify empty
        const check = await app.handle(new Request(`http://localhost/api/users/${testUserId}/memories`));
        const checkData = await check.json();
        expect(checkData.items.length).toBe(0);
    });
});
