import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { closeDb, waitForDb } from "../../src/core/db";

// Mock the database q object before importing userRoutes
mock.module("../../src/core/db", () => ({
    q: {
        getActiveUsers: {
            all: mock(async () => [{ userId: "user1" }, { userId: "user2" }])
        },
        getUser: {
            get: mock(async (id: string) => (id === "user1" ? { userId: "user1", summary: "Reflective", reflectionCount: 5, updatedAt: Date.now() } : undefined))
        },
        delUserCascade: {
            run: mock(async () => 1)
        }
    },
    waitForDb: async () => true,
    closeDb: async () => { }
}));

// Mock auth middleware
mock.module("../../src/server/middleware/auth", () => ({
    verifyUserAccess: (user: any, targetId: string) => {
        const isAdmin = (user?.scopes || []).includes("admin:all");
        const authId = user?.id;
        if (!targetId) return null;
        if (authId === targetId || isAdmin) return targetId;
        return null;
    },
    getUser: (ctx: any) => ctx.store?.user || null
}));

// Mock Memory class
mock.module("../../src/core/memory", () => ({
    Memory: class {
        constructor(public userId: string | null) { }
        async list(limit: number, offset: number) { return []; }
        async wipeUserContent(userId: string) { return 5; }
    }
}));

// Mock user summary functions
mock.module("../../src/memory/user_summary", () => ({
    autoUpdateUserSummaries: mock(async () => ({ updated: 3 })),
    updateUserSummary: mock(async () => { })
}));

import { userRoutes } from "../../src/server/routes/users";
import { AppError } from "../../src/server/errors";

describe("User Routes RBAC", () => {
    let app: Elysia;

    beforeEach(async () => {
        // Create a fresh Elysia app for each test with error handler
        app = new Elysia()
            .onError(({ error, set }) => {
                if (error instanceof AppError) {
                    set.status = error.statusCode;
                    return { success: false, error: error.code, message: error.message };
                }
                // For other errors, check if they have a status property
                if (error && typeof error === "object" && "statusCode" in error) {
                    set.status = (error as any).statusCode;
                    return { success: false, error: "ERROR", message: (error as Error).message };
                }
                set.status = 500;
                return { success: false, error: "INTERNAL_ERROR", message: (error as Error).message };
            })
            .derive(({ headers }) => {
                // Simulate user from headers
                const userHeader = headers["x-test-user"];
                if (userHeader) {
                    return { store: { user: JSON.parse(userHeader) } };
                }
                return { store: { user: null } };
            })
            .use(userRoutes);
    });

    afterEach(async () => {
        // Cleanup
    });

    it("GET /users - Admin Allowed", async () => {
        const response = await app.handle(
            new Request("http://localhost/users", {
                headers: { "x-test-user": JSON.stringify({ id: "admin", scopes: ["admin:all"] }) }
            })
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.success).toBe(true);
        expect(body.users).toContain("user1");
    });

    it("GET /users - User Denied", async () => {
        const response = await app.handle(
            new Request("http://localhost/users", {
                headers: { "x-test-user": JSON.stringify({ id: "user1", scopes: ["memory:read"] }) }
            })
        );
        expect(response.status).toBe(403);
    });

    it("GET /users/:userId - Own Profile Allowed", async () => {
        const response = await app.handle(
            new Request("http://localhost/users/user1", {
                headers: { "x-test-user": JSON.stringify({ id: "user1", scopes: ["memory:read"] }) }
            })
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.userId).toBe("user1");
    });

    it("GET /users/:userId - Other Profile Denied", async () => {
        const response = await app.handle(
            new Request("http://localhost/users/user1", {
                headers: { "x-test-user": JSON.stringify({ id: "user2", scopes: ["memory:read"] }) }
            })
        );
        // verifyUserAccess returns null -> AppError 400
        expect(response.status).toBe(400);
    });

    it("GET /users/:userId - Admin Access Other Profile Allowed", async () => {
        const response = await app.handle(
            new Request("http://localhost/users/user1", {
                headers: { "x-test-user": JSON.stringify({ id: "admin", scopes: ["admin:all"] }) }
            })
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.userId).toBe("user1");
    });
});
