import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { authenticateApiRequest } from "../../src/server/middleware/auth";
import { env } from "../../src/core/cfg";

describe("RBAC Authentication", () => {
    // Mock Config
    const originalApiKey = env.apiKey;
    const originalAdminKey = env.adminKey;

    // Reset env after tests
    // Note: updating imported 'env' might not work directly if it's immutable, 
    // but typically we can mutate the object or mock it.
    // Since 'env' is an object exported from cfg.ts, let's try mutating it for test purposes if possible
    // or rely on reloadConfig if we were using it. 
    // For now, we will mock the request behavior assuming env is readable.

    // Actually, cfg.ts exports 'env' as a variable, but assignments to it locally won't propagate 
    // unless we use 'reloadConfig' or modify the object properties if it's mutable.
    // 'env' is an object, so we can modify properties.

    it("should allow public endpoints without auth", async () => {
        const req = { path: "/health", headers: {} } as any;
        const res = {} as any;
        let nextCalled = false;
        const next = () => { nextCalled = true; };

        await authenticateApiRequest(req, res, next);
        expect(nextCalled).toBe(true);
    });

    it("should reject missing key when auth is enabled", async () => {
        // Mock env
        env.apiKey = "secret";
        env.adminKey = "supersecret";

        const req = { path: "/api/protected", headers: {} } as any;
        const res = {
            writeHead: (code: number, headers: any) => {
                expect(code).toBe(401);
            },
            end: (body: string) => {
                const parsed = JSON.parse(body);
                expect(parsed.error).toBe("authentication_required");
            }
        } as any;
        const next = () => { throw new Error("Should not call next"); };

        await authenticateApiRequest(req, res, next);
    });

    it("should grant memory:read/write scopes for standard key", async () => {
        env.apiKey = "secret";

        const req = {
            path: "/api/protected",
            headers: { "x-api-key": "secret" },
            ip: "127.0.0.1"
        } as any;
        const res = {} as any;

        let nextCalled = false;
        const next = () => { nextCalled = true; };

        await authenticateApiRequest(req, res, next);

        expect(nextCalled).toBe(true);
        expect(req.user).toBeDefined();
        // ID is hash of key, so we just check scopes
        expect(req.user.scopes).toContain("memory:read");
        expect(req.user.scopes).toContain("memory:write");
        expect(req.user.scopes).not.toContain("admin:all");
    });

    it("should grant admin:all scope for admin key", async () => {
        env.adminKey = "supersecret";

        const req = {
            path: "/api/protected",
            headers: { "x-api-key": "supersecret" },
            ip: "127.0.0.1"
        } as any;
        const res = {} as any;

        let nextCalled = false;
        const next = () => { nextCalled = true; };

        await authenticateApiRequest(req, res, next);

        expect(nextCalled).toBe(true);
        expect(req.user.scopes).toContain("admin:all");
    });
});

describe("Security: Auth Middleware Edge Cases", () => {
    let req: any;
    let res: any;
    let next: any;
    let originalEnv: any;
    // Import reloadConfig dynamically or mock it if needed. 
    // Since we are mocking 'env' properties directly in previous tests, we might continue that pattern 
    // BUT auth_security used 'reloadConfig'. 
    // Let's assume we can just mutate 'env' or process.env if the module reads from process.env on every request?
    // Actually authenticateApiRequest uses 'env.apiKey' etc. which are exported constants/vars.
    // If 'env' is a live binding or object, we can mutate it.

    // Check if we need to reload config. 'env' in cfg.ts might be populated once.
    // If we can't easily reload, we'll manually set env properties.

    beforeEach(() => {
        originalEnv = { ...env };
        req = { path: "/api/memory/add", headers: {}, user: undefined };
        res = {
            status: mock((code) => res),
            json: mock((body) => res),
            setHeader: mock((k, v) => { }),
            send: mock((body) => res)
        };
        next = mock(() => { });
    });

    afterEach(() => {
        Object.assign(env, originalEnv);
    });

    it("BLOCKS request if NO keys set and OM_NO_AUTH is missing", async () => {
        env.apiKey = undefined;
        env.adminKey = undefined;
        env.noAuth = false;

        await authenticateApiRequest(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(500);
    });

    it("ALLOWS request if NO keys set but OM_NO_AUTH=true", async () => {
        env.apiKey = undefined;
        env.adminKey = undefined;
        env.noAuth = true;

        await authenticateApiRequest(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.user).toBeDefined();
        expect(req.user.id).toBe("anonymous");
    });

    it("BLOCKS request if INVALID API Key provided", async () => {
        env.apiKey = "valid-key";
        env.noAuth = false;
        req.headers["x-api-key"] = "wrong-key";

        await authenticateApiRequest(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});
