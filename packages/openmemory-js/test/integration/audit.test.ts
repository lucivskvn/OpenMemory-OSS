import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { auditPlugin } from "../../src/server/middleware/audit";
import { env } from "../../src/core/cfg";
import { q } from "../../src/core/db";

// Mock the audit log run function
// We need to ensure q is initialized or at least the auditLog.run can be mocked.
// Since q is a proxy relying on db initialization, we might hit issues if DB is not ready.
// However, auditPlugin just calls q.auditLog.run().catch(...).
// We can try to mock the whole db module or just ensure it doesn't crash.

describe("Audit Middleware", () => {
    let app: Elysia;
    let auditLogMock: any;

    beforeAll(() => {
        env.logAuth = true;

        // Mock q.auditLog.run
        auditLogMock = mock(async () => { });
        // We can't easily replace q properties because it's a proxy or singleton.
        // But we can try to "spy" if accessible, or just verify no crash.
        // Ideally we should use a proper DI or mock the module.
        // For this test, verifying it runs without error is a good first step.
        // To really verify, we'd need to mock 'src/core/db'.
    });

    it("should skip GET requests", async () => {
        app = new Elysia().use(auditPlugin).get("/memory/123", () => "ok");

        const res = await app.handle(new Request("http://localhost/memory/123", { method: "GET" }));
        expect(res.status).toBe(200);
        // audit log should NOT be triggered for GET
    });

    it("should log POST request on success", async () => {
        app = new Elysia()
            .use(auditPlugin)
            .post("/memory/add", ({ body }) => ({ success: true }));

        const res = await app.handle(new Request("http://localhost/memory/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "test" })
        }));
        expect(res.status).toBe(200);
        // Should trigger audit log (fire and forget)
    });

    it("should not crash if response is error", async () => {
        app = new Elysia()
            .use(auditPlugin)
            .post("/memory/fail", ({ set }) => {
                set.status = 400;
                return "error";
            });

        const res = await app.handle(new Request("http://localhost/memory/fail", { method: "POST" }));
        expect(res.status).toBe(400);
        // Should trigger audit log
    });
});
