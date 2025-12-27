import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin, _resetRateLimitStore } from "../../src/server/middleware/auth";
import { authConfig, env } from "../../src/core/cfg";

describe("Auth rate limiting", () => {
    beforeEach(() => {
        _resetRateLimitStore();
    });

    it("should 429 after IP rate limit exceeded", async () => {
        // Set small limit
        (authConfig as any).rate_limit_enabled = true;
        (authConfig as any).rate_limit_max_requests = 2;
        (authConfig as any).rate_limit_window_ms = 10000;

        const app = new Elysia();
        app.use(authPlugin);
        app.get('/test', () => ({ ok: true }));

        // Hit endpoint 3 times from same 'ip'
        const req = new Request("http://localhost/test", { headers: { "x-forwarded-for": "1.2.3.4" } });
        let res = await app.handle(req);
        expect(res.status).not.toBe(429);
        res = await app.handle(req);
        expect(res.status).not.toBe(429);
        res = await app.handle(req);
        expect(res.status).toBe(429);
    });

    it("should enforce per-key quota after valid key", async () => {
        // Configure API key and small per-key quota
        (authConfig as any).api_key = "testkey";
        (authConfig as any).rate_limit_enabled = true;
        (authConfig as any).rate_limit_max_requests = 2;
        (authConfig as any).rate_limit_window_ms = 10000;

        const app = new Elysia();
        app.use(authPlugin);
        app.get('/protected', () => ({ ok: true }));

        const headers = { authorization: `Bearer testkey` };
        const req = new Request("http://localhost/protected", { headers });

        let res = await app.handle(req);
        expect(res.status).not.toBe(429);
        res = await app.handle(req);
        expect(res.status).not.toBe(429);
        // third should be quota exceeded
        res = await app.handle(req);
        expect(res.status).toBe(429);
    });
});
