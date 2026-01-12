import { describe, expect, it, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { app } from "../../src/server/index";
import { q, closeDb, runAsync } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { reloadConfig } from "../../src/core/cfg";
import { Memory } from "../../src/core/memory";

// Mock the user summary generation to avoid LLM calls
mock.module("../../src/memory/user_summary", () => {
    return {
        updateUserSummary: mock(async (userId: string) => {
            // Simulate db update
            await q.updUserSummary.run(userId, "Regenerated Summary Mock", Date.now());
        }),
        autoUpdateUserSummaries: mock(async () => { return { updated: 1 }; })
    };
});

async function getClientId(apiKey: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", Buffer.from(apiKey));
    return Buffer.from(hash).toString("hex").slice(0, 16);
}

describe("User Routes Hardening & RBAC", () => {
    let server: any;
    const userKey = "user-key-verify";
    let userId: string;
    const adminKey = "admin-key-verify";
    let adminId: string;
    const otherKey = "other-key-verify"; // Attacker
    let otherId: string;

    beforeAll(async () => {
        userId = await getClientId(userKey);
        adminId = await getClientId(adminKey);
        otherId = await getClientId(otherKey);

        process.env.OM_API_KEY = userKey;
        process.env.OM_ADMIN_KEY = adminKey;
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();

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

        await q.insUser.run(userId, "User Summary", 0, Date.now(), Date.now());
        await q.insUser.run(otherId, "Attacker Summary", 0, Date.now(), Date.now());

        // Add 'Other' Key to DB so they are a valid authenticated user
        const otherHashRaw = await crypto.subtle.digest("SHA-256", Buffer.from(otherKey));
        const otherHash = Buffer.from(otherHashRaw).toString("hex");
        await q.insApiKey.run(otherHash, otherId, "user", "Other User Key", Date.now(), Date.now(), 0);

        // Add some memories for victim
        const m = new Memory(userId);
        await m.add("Secret Memory 1");
        await m.add("Secret Memory 2");
    });

    const request = async (path: string, options: any = {}) => {
        const url = `http://localhost:8080${path}`;
        // Ensure headers are merged correctly
        const headers = {
            "Content-Type": "application/json",
            ...options.headers
        };

        return await server.fetch(new Request(url, {
            ...options,
            headers
        }));
    };

    describe("GET /users/:userId/memories", () => {
        it("Owner can list their memories", async () => {
            const res = await request(`/users/${userId}/memories`, {
                headers: { "x-api-key": userKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.items).toHaveLength(2);
            expect(body.items[0].content).toContain("Secret Memory");
        });

        it("Admin can list user memories", async () => {
            const res = await request(`/users/${userId}/memories`, {
                headers: { "x-api-key": adminKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.items).toHaveLength(2);
        });

        it("Other user CANNOT list victim memories", async () => {
            // "Other" tries to read "User's" memories
            // We need to enable "Other" access first? 
            // The system uses ONE api key (OM_API_KEY).
            // To simulating "Other" user, we need Dynamic Keys in DB.
            // Or we rely on the fact that if we use the "standard key", we are "userId".
            // To simulate "Other", we'd need another valid key.
            // Since we only have OM_API_KEY and OM_ADMIN_KEY in basic config,
            // we must use Dynamic Keys (DB) to simulate separate users.

            // Register "Other" key in DB
            // We have to bypass auth to insert key or use Admin.
            // But we can directly use 'q'.

            // Hash for 'otherKey'
            const otherHashRaw = await crypto.subtle.digest("SHA-256", Buffer.from(otherKey));
            const otherHash = Buffer.from(otherHashRaw).toString("hex");

            await q.insApiKey.run(otherHash, otherId, "user", "Other User Key", Date.now(), Date.now(), 0);

            // Now use 'otherKey'
            const res = await request(`/users/${userId}/memories`, {
                headers: { "x-api-key": otherKey }
            });

            expect(res.status).toBe(403);
            const body = await res.json();
            // Error response is usually { error: { code: ... } } or { error: ... } depending on AppError serialization
            // Based on failure logs, body.error IS { code: "FORBIDDEN", ... }
            expect(body.error.code).toBe("FORBIDDEN");
        });
    });

    describe("POST /users/:userId/summary/regenerate", () => {
        it("Owner can regenerate summary", async () => {
            const res = await request(`/users/${userId}/summary/regenerate`, {
                method: "POST",
                headers: { "x-api-key": userKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.ok).toBe(true);
        });

        it("Other user CANNOT regenerate victim summary", async () => {
            const res = await request(`/users/${userId}/summary/regenerate`, {
                method: "POST",
                headers: { "x-api-key": otherKey } // Set up in previous test? implicit beforeEach? No DB cleared.
                // Re-insert needed because beforeEach clears? 
                // Wait, beforeEach clears 'users' table? No, it clears DELETE FROM users.
                // API Keys are in 'api_keys' table.
                // beforeEach clears users and memories.
                // Note: Foreign Key constraints might fail if we delete users but keep keys.
                // Best to clear keys too.
            });
            expect(res.status).toBe(403);
        });
    });
});
