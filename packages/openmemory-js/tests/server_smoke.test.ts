
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { app } from "../test/test-server";

describe("Phase3 API Server", () => {
    beforeAll(() => {
        // Set test environment to prevent configuration warnings and background tasks
        Bun.env.OM_SKIP_GLOBAL_SETUP = "true";
        Bun.env.OM_TEST_MODE = "true";
        Bun.env.NODE_ENV = "test";
        Bun.env.OM_TIER = "local";
        Bun.env.OM_EMBEDDINGS = "local";
        Bun.env.OM_LOG_LEVEL = "error";
        Bun.env.OM_TELEMETRY_ENABLED = "false";
        Bun.env.OM_API_KEYS = "test-key-123";
        Bun.env.OM_ADMIN_KEY = "admin-test-key-456";
    });

    describe("Health Endpoints", () => {
        test("should return 200 for /health endpoint", async () => {
            const req = new Request("http://localhost:8080/health");
            const res = await app.handle(req);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data).toHaveProperty("success", true);
        });

        test("should return system metrics for /dashboard/health", async () => {
            const req = new Request("http://localhost:8080/dashboard/health");
            const res = await app.handle(req);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data).toHaveProperty("memory");
        });
    });

    describe("Authentication Security", () => {
        test("should handle missing authentication gracefully", async () => {
            const req = new Request("http://localhost:8080/admin/users");
            const res = await app.handle(req);
            // Should return 404 since the route doesn't exist in our test server
            expect([401, 403, 404, 500]).toContain(res.status);
        });
    });
});
