import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { rateLimitMiddleware } from "../../src/server/middleware/rateLimit"; // Adjust path if needed
import { cache } from "../../src/core/cache";
import { env } from "../../src/core/cfg";

// Mock cache
mock.module("../../src/core/cache", () => ({
    cache: {
        incr: mock(async () => 1),
    }
}));

// Mock logger to suppress noise
mock.module(".../../utils/logger", () => ({
    logger: {
        warn: mock(() => { }),
        error: mock(() => { }),
    }
}));


describe("Rate Limit Middleware (Smart Limiting)", () => {
    let req: any;
    let res: any;
    let next: any;
    let originalEnv: any;

    beforeEach(() => {
        originalEnv = { ...env };
        env.rateLimitEnabled = true;
        env.rateLimitMaxRequests = 5;
        env.rateLimitWindowMs = 60000;

        req = {
            ip: "127.0.0.1",
            headers: {},
            user: undefined
        };
        res = {
            headers: {},
            statusCode: 200,
            setHeader: mock((k, v) => { res.headers[k] = v; }),
            status: mock((code) => { res.statusCode = code; return res; }),
            json: mock((body) => res),
            end: mock(() => { }) // Shim for sendError
        };
        next = mock(() => { });

        // Reset mock implementations
        (cache.incr as any).mockClear();
    });

    afterEach(() => {
        Object.assign(env, originalEnv);
    });

    it("should use IP key for anonymous requests", async () => {
        (cache.incr as any).mockResolvedValue(1);

        await rateLimitMiddleware(req, res, next);

        expect(cache.incr).toHaveBeenCalledWith("rl:ip:127.0.0.1", expect.any(Number));
        expect(next).toHaveBeenCalled();
    });

    it("should use User ID key for authenticated requests", async () => {
        (cache.incr as any).mockResolvedValue(1);
        req.user = { id: "user-123" };

        await rateLimitMiddleware(req, res, next);

        expect(cache.incr).toHaveBeenCalledWith("rl:user:user-123", expect.any(Number));
        expect(next).toHaveBeenCalled();
    });

    it("should block request if limit exceeded", async () => {
        (cache.incr as any).mockResolvedValue(6); // Max is 5

        // Mock sendError behavior or spy on it if mocked.
        // Assuming sendError uses res methods we mocked.

        // We'll trust the middleware calls res methods or throws?
        // Actually the middleware calls sendError. sendError writes to res.
        // We need to verify it returns a response and DOES NOT call next().

        await rateLimitMiddleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.headers["Retry-After"]).toBeDefined();
    });

    it("should allow request if limit not exceeded", async () => {
        (cache.incr as any).mockResolvedValue(5); // Max is 5

        await rateLimitMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.headers["X-RateLimit-Remaining"]).toBe("0");
    });

    it("should skip if disabled", async () => {
        env.rateLimitEnabled = false;

        await rateLimitMiddleware(req, res, next);

        expect(cache.incr).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });
});
