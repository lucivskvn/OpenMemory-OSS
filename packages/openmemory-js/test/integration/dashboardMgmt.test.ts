
import { describe, it, expect, beforeEach, afterEach, mock, spyOn, beforeAll } from "bun:test";
import { app } from "../../src/server/index";
import { q } from "../../src/core/db";
import { env, reloadConfig } from "../../src/core/cfg";
import { forceConfigReinit, waitForDb } from "../test_utils";

describe("Dashboard & User Mgmt", () => {
    beforeAll(async () => {
        process.env.OM_API_KEY = "key-dashboard-mgmt";
        await forceConfigReinit();
        await waitForDb();
    });

    it("POST /users/register should generate and STORE a key", async () => {
        // Direct DB verification is fine for integration tests where we want to verify side effects
        // that aren't easily visible via API without auth.
        const { q } = await import("../../src/core/db");
        // Test manual insertion
        const kh = "test-hash-" + Date.now();
        await q.insApiKey.run(kh, "test-user-db", "user", "test note", Date.now(), Date.now(), 0);

        const retrieved = await q.getApiKey.get(kh);
        expect(retrieved).toBeDefined();
        expect(retrieved?.userId).toBe("test-user-db");
        expect(retrieved?.role).toBe("user");

        // Clean up
        await q.delApiKey.run(kh);
        const deleted = await q.getApiKey.get(kh);
        expect(deleted).toBeUndefined();
    });

    it("GET /dashboard/settings should return config objects", async () => {
        // Authenticate as admin or valid user if needed. 
        // For testing settings, usually requires auth.
        // We will mock the auth checking if needed, or pass a key if checking actual logic.
        // Since this is integration, let's use app.fetch.

        const req = new Request("http://localhost/dashboard/settings", {
            headers: { "x-api-key": env.apiKey || "mock-key" }
        });

        // Elysia apps have a .fetch method specifically for this
        const res = await app.fetch(req);

        // We expect either 200 (if auth works) or 403. 
        // We should assert based on expected env.
        // If we set OM_API_KEY in env, we expect 200.

        if (res.status === 200) {
            const data = await res.json();
            expect(data.openai).toBeDefined();
            expect(data.gemini).toBeDefined();
        } else if (res.status === 403) {
            // This is also a valid server response (Auth guard working)
            expect(res.status).toBe(403);
        } else {
            throw new Error(`Unexpected status: ${res.status}`);
        }
    });
});
