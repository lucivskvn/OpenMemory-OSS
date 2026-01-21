import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { setupRoutes } from "../../src/server/routes/setup";
import { setupTokenManager } from "../../src/server/setup_token";
import { waitForDb, closeDb } from "../../src/core/db";
import { env } from "../../src/core/cfg";
import server from "../../src/server/server";

describe("Setup Routes", () => {
    let app: any;

    beforeAll(async () => {
        // Force in-memory DB for tests
        env.dbPath = ":memory:";
        // Initialize DB (creates tables)
        await waitForDb();
        app = server().use(setupRoutes);
    });

    afterAll(async () => {
        await closeDb();
    });

    it("GET /setup/status should return status", async () => {
        const res = await app.handle(new Request("http://localhost/setup/status"));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toHaveProperty("setupMode");
    });

    it("POST /setup/verify should fail with invalid token", async () => {
        const body = JSON.stringify({ userId: "testuser", token: "invalid" });
        const res = await app.handle(
            new Request("http://localhost/setup/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            })
        );
        expect(res.status).toBe(403);
    });

    it("POST /setup/verify should succeed with valid token", async () => {
        const token = setupTokenManager.generate();
        const body = JSON.stringify({ userId: "admin", token });
        const res = await app.handle(
            new Request("http://localhost/setup/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            })
        );
        expect(res.status).toBe(200);
        const json: any = await res.json();
        expect(json.success).toBe(true);
        expect(json.role).toBe("admin");
        expect(json.apiKey).toStartWith("om_");

        // Verify Setup Mode is now disabled
        const resStats = await app.handle(new Request("http://localhost/setup/status"));
        const jsonStats: any = await resStats.json();
        expect(jsonStats.setupMode).toBe(false);
    });
});
