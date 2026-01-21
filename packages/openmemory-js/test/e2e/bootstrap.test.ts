import { describe, it, expect } from "bun:test";
import { app } from "../../src/server/index";
import { q, runAsync, TABLES } from "../../src/core/db";
import { setupTokenManager } from "../../src/server/setup_token";

describe("Admin Bootstrap (Console Token)", () => {

    it("POST /setup/verify should fail without token or invalid token", async () => {
        // Clear any existing
        setupTokenManager.clear();

        const req = new Request("http://localhost/setup/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: "admin", token: "wrong" })
        });

        const res = await app.fetch(req, {} as any);
        expect(res.status).toBe(403);
    });

    it("Console Token Flow: Generate -> Verify -> Admin Created", async () => {
        // 1. Reset DB
        await runAsync(`DELETE FROM ${TABLES.api_keys}`);

        // 2. Simulate Server Startup Generation
        const token = setupTokenManager.generate();
        expect(token).toBeDefined();

        // 3. Verify with correct token
        const body = JSON.stringify({ userId: "console-admin", token: token });
        const req = new Request("http://localhost/setup/verify", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(body))
            },
            body: body
        });

        const res = await app.fetch(req, {} as any);
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.role).toBe("admin");

        // 4. Verify Admin Exists in DB
        const count = await q.getAdminCount.get();
        expect(count?.count).toBe(1);

        // 5. Verify Token is Consumed
        expect(setupTokenManager.get()).toBeNull();

        // 6. Verify Re-use fails
        const body2 = JSON.stringify({ userId: "hacker", token: token });
        const req2 = new Request("http://localhost/setup/verify", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(body2))
            },
            body: body2
        });
        const res2 = await app.fetch(req2, {} as any);
        expect(res2.status).toBe(403);
    });
});
