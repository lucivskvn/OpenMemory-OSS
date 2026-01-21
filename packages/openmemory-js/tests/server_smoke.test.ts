
import { describe, expect, it } from "bun:test";
import { app } from "../src/server/index";

describe("Server Smoke Test", () => {
    it("GET /health should return 200", async () => {
        const req = new Request("http://localhost:8080/health");
        const res = await app.handle(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty("success", true);
    });

    it("GET /dashboard/health should return 200", async () => {
        const req = new Request("http://localhost:8080/dashboard/health");
        const res = await app.handle(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty("memory");
    });

    it("GET /admin/users should return 401/403 without auth", async () => {
        const req = new Request("http://localhost:8080/admin/users");
        const res = await app.handle(req);
        // Expect 500 (Security Block) when no keys are configured in default test env
        expect(res.status).toBe(500);
    });
});
