import { describe, expect, it, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { app } from "../../src/server/index";
import { q, closeDb, runAsync, waitForDb } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { reloadConfig } from "../../src/core/cfg";
import { Memory } from "../../src/core/memory";

async function getClientId(apiKey: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", Buffer.from(apiKey));
    return Buffer.from(hash).toString("hex");
}

// Mock user_summary explicitly if needed to avoid timeouts, 
// though DELETE or GET /admin/users usually don't trigger LLM unless creating user with summary.
// We are creating users directly via DB or POST.
// POST /admin/users allows creating users. It might use summary logic? 
// Checking admin.ts: await q.insUser.run(...) -> No LLM.
// Logic seems safe.

describe("Admin Routes Hardening", () => {
    let server: any;
    const adminKey = "admin-key-verify";
    let adminId: string;
    const userKey = "user-key-verify";
    let userId: string;

    beforeAll(async () => {
        adminId = await getClientId(adminKey);
        userId = await getClientId(userKey);

        process.env.OM_API_KEY = userKey;
        process.env.OM_ADMIN_KEY = adminKey;
        reloadConfig();

        // Ensure DB is ready before server operations
        await waitForDb();

        server = app;
    });


    afterAll(async () => {
        await stopAllMaintenance();
        await closeDb();
    });

    beforeEach(async () => {
        await runAsync("DELETE FROM users");
        await runAsync("DELETE FROM memories");
        await runAsync("DELETE FROM api_keys");
        await runAsync("DELETE FROM source_configs");

        // Create Admin and Standard User
        await q.insUser.run(adminId, "Admin", 0, Date.now(), Date.now());
        await q.insUser.run(userId, "User", 0, Date.now(), Date.now());
    });

    const request = async (path: string, options: any = {}) => {
        const url = `http://localhost:8080${path}`;
        const headers = {
            "Content-Type": "application/json",
            ...options.headers
        };
        return await server.fetch(new Request(url, { ...options, headers }));
    };

    describe("GET /admin/users", () => {
        it("Admin can list users", async () => {
            const res = await request("/admin/users", {
                headers: { "x-api-key": adminKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            // Should contain at least 2 users (admin + user)
            expect(body.users.length).toBeGreaterThanOrEqual(2);
            expect(body.users[0]).toHaveProperty("userId");
            expect(body.users[0]).toHaveProperty("summary");
        });

        it("Non-admin CANNOT list users", async () => {
            const res = await request("/admin/users", {
                headers: { "x-api-key": userKey }
            });
            expect(res.status).toBe(403);
        });

        it("Pagination limits result size", async () => {
            // Ensure we have at least 2 users.
            // Request limit=1
            const res = await request("/admin/users?l=1", {
                headers: { "x-api-key": adminKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.users).toHaveLength(1);
        });
    });

    describe("DELETE /admin/users/:userId", () => {
        it("Admin can delete a user and all data", async () => {
            // Setup data for user
            const m = new Memory(userId);
            await m.add("User Memory");
            await q.insSourceConfig.run(userId, "test_source", "{}", "enabled", Date.now(), Date.now());

            // Delete
            const res = await request(`/admin/users/${userId}`, {
                method: "DELETE",
                headers: { "x-api-key": adminKey }
            });
            expect(res.status).toBe(200);

            // Verify User Gone
            const u = await q.getUser.get(userId);
            expect(u).toBeUndefined();

            // Verify Memory Gone
            const mems = await m.list();
            expect(mems).toHaveLength(0);

            // Verify Source Config Gone
            const sc = await q.getSourceConfigsByUser.all(userId);
            expect(sc).toHaveLength(0);
        });
    });
});
