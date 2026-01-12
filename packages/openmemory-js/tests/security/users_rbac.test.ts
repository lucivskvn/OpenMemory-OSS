import { describe, it, expect, mock, beforeEach } from "bun:test";
import { userRoutes } from "../../src/server/routes/users"; // Adjust path
import { AppError } from "../../src/server/errors";

// Mock DB
mock.module("../../src/core/db", () => ({
    q: {
        getActiveUsers: {
            all: mock(async () => [{ userId: "user1" }, { userId: "user2" }])
        },
        getUser: {
            get: mock(async (id) => (id === "user1" ? { userId: "user1", summary: "Reflective" } : undefined))
        }
    },
    // Mock other DB ops if needed
}));

// Mock Middleware (verifyUserAccess) - We want to test the ROUTE Logic calling it
// But verifying the route handles the error correctly
mock.module("../../src/server/middleware/auth", () => ({
    verifyUserAccess: (req: any, targetId: string) => {
        const isAdmin = (req.user?.scopes || []).includes("admin:all");
        const authId = req.user?.id;
        if (authId !== targetId && !isAdmin) {
            throw new AppError(403, "FORBIDDEN", "Access denied");
        }
    }
}));

// Mock Validate (Pass through)
mock.module("../../src/server/middleware/validate", () => ({
    validateParams: () => (req: any, res: any, next: any) => next(),
    validateQuery: () => (req: any, res: any, next: any) => next(),
}));

describe("User Routes RBAC", () => {
    let handlers: Record<string, Function> = {};
    let app: any;
    let req: any;
    let res: any;

    beforeEach(() => {
        handlers = {};
        app = {
            get: (path: string, ...args: any[]) => {
                const handler = args[args.length - 1]; // Last arg is handler
                handlers[`GET ${path}`] = handler;
            },
            post: (path: string, ...args: any[]) => {
                const handler = args[args.length - 1];
                handlers[`POST ${path}`] = handler;
            },
            delete: (path: string, ...args: any[]) => {
                const handler = args[args.length - 1];
                handlers[`DELETE ${path}`] = handler;
            }
        };

        userRoutes(app);

        res = {
            status: mock((c) => res),
            json: mock((j) => res),
            setHeader: mock(() => { }), // Shim
            writeHead: mock(() => { })  // Shim
        };
    });

    it("GET /users - Admin Allowed", async () => {
        req = { user: { id: "admin", scopes: ["admin:all"] } };
        await handlers["GET /users"](req, res);
        expect(res.json).toHaveBeenCalled();
    });

    it("GET /users - User Denied", async () => {
        req = { user: { id: "user1", scopes: ["memory:read"] } };

        // The handler calls sendError which we assume writes 403
        // We need to mock sendError or check res calls
        // Since we didn't mock sendError, it imports real one which uses res methods.
        // real sendError calls res.status(code).json(...) or writeHead/end.
        // Let's assume standard behavior.

        await handlers["GET /users"](req, res);

        // Verify 403 was sent
        // sendError usually sets status
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it("GET /users/:userId - Own Profile Allowed", async () => {
        req = {
            user: { id: "user1", scopes: ["memory:read"] },
            params: { userId: "user1" }
        };
        await handlers["GET /users/:userId"](req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ userId: "user1" }));
    });

    it("GET /users/:userId - Other Profile Denied", async () => {
        req = {
            user: { id: "user2", scopes: ["memory:read"] },
            params: { userId: "user1" }
        };
        await handlers["GET /users/:userId"](req, res);
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it("GET /users/:userId - Admin Access Other Profile Allowed", async () => {
        req = {
            user: { id: "admin", scopes: ["admin:all"] },
            params: { userId: "user1" }
        };
        await handlers["GET /users/:userId"](req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ userId: "user1" }));
    });
});
