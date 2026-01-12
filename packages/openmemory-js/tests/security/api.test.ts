import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { app } from "../../src/server/index";
import { q, closeDb, runAsync } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { reloadConfig } from "../../src/core/cfg";
import { Memory } from "../../src/core/memory";

async function getClientId(apiKey: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", Buffer.from(apiKey));
    return Buffer.from(hash).toString("hex").slice(0, 16);
}

describe("API Hardening & Standardization", () => {
    let server: any;
    const standardUserKey = "dummy-root-key";
    let standardUserId: string;
    const adminKey = "admin-key-123";
    let adminUserId: string;
    const otherUserId = "other-user-999";

    beforeAll(async () => {
        standardUserId = await getClientId(standardUserKey);
        adminUserId = await getClientId(adminKey);

        process.env.OM_API_KEY = standardUserKey;
        process.env.OM_ADMIN_KEY = adminKey;
        reloadConfig();

        server = app;
    });

    afterAll(async () => {
        await stopAllMaintenance();
        await closeDb();
    });

    beforeEach(async () => {
        await runAsync("DELETE FROM users");
        await q.insUser.run(standardUserId, "Standard User Summary", 0, Date.now(), Date.now());
        await q.insUser.run(otherUserId, "Other User Summary", 0, Date.now(), Date.now());
        await q.insUser.run(adminUserId, "Admin Summary", 0, Date.now(), Date.now());
    });

    const request = async (path: string, options: any = {}) => {
        const url = `http://localhost:8080${path}`;
        const res = await server.fetch(new Request(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...options.headers
            }
        }));
        return res;
    };

    describe("RBAC: User Routes", () => {
        it("Standard User should access their own profile", async () => {
            const res = await request(`/users/${standardUserId}`, {
                headers: { "x-api-key": standardUserKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.userId).toBe(standardUserId);
        });

        it("Standard User should NOT access Other User's profile", async () => {
            const res = await request(`/users/${otherUserId}`, {
                headers: { "x-api-key": standardUserKey }
            });
            expect(res.status).toBe(403);
        });

        it("Admin should access Other User's profile", async () => {
            const res = await request(`/users/${otherUserId}`, {
                headers: { "x-api-key": adminKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.userId).toBe(otherUserId);
        });
    });

    describe("Robustness: Date Parsing (Temporal)", () => {
        it("Valid date should return 200/404 (not 500)", async () => {
            const res = await request(`/temporal/fact?subject=Alice&at=2023-01-01`, {
                headers: { "x-api-key": adminKey }
            });
            expect([200, 404]).toContain(res.status);
        });

        it("Invalid date should return 400 (Bad Request), not 500", async () => {
            const res = await request(`/temporal/fact?subject=Alice&at=invalid-date-format`, {
                headers: { "x-api-key": adminKey }
            });
            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toBeDefined();
        });
    });

    describe("Validation: Memory Max Length", () => {
        it("Should reject content > 100kb", async () => {
            const hugeContent = "a".repeat(1024 * 110); // 110kb
            const res = await request("/memory/add", {
                method: "POST",
                headers: { "x-api-key": standardUserKey },
                body: JSON.stringify({ content: hugeContent })
            });
            expect(res.status).toBe(400); // Validation Error (Too Big)
        });
    });

    describe("Validation: Invalid JSON", () => {
        it("Should return 400 for malformed JSON", async () => {
            const res = await request("/memory/add", {
                method: "POST",
                headers: {
                    "x-api-key": standardUserKey
                },
                body: "{ malformed: json }"
            });
            expect(res.status).toBe(400);
        });
    });

    describe("Logic: Batch Deletion", () => {
        it("Should delete all user memories (pagination check)", async () => {
            const mem = new Memory(standardUserId);
            // Add 5 memories
            for (let i = 0; i < 5; i++) {
                await mem.add(`Memory ${i}`);
            }

            const res = await request(`/users/${standardUserId}/memories`, {
                method: "DELETE",
                headers: { "x-api-key": standardUserKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.deleted).toBeGreaterThanOrEqual(5);

            const listRes = await request(`/users/${standardUserId}/memories`, {
                headers: { "x-api-key": standardUserKey }
            });
            const listBody = await listRes.json();
            expect(listBody.items.length).toBe(0);
        });
    });

    describe("Validation: Sources Webhook", () => {
        it("Should reject empty payload for Notion", async () => {
            const res = await request("/sources/webhook/notion", {
                method: "POST",
                headers: { "x-api-key": adminKey },
                body: JSON.stringify({})
            });
            expect(res.status).toBe(400);
        });
    });
    describe("Dashboard: Stats", () => {
        it("Should return correct stats structure", async () => {
            const res = await request("/dashboard/stats", {
                headers: { "x-api-key": adminKey }
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.totalMemories).toBeDefined();
            expect(body.qps).toBeDefined();
            // This verifies stats.ts integration
        });
    });
});
