import { describe, expect, it, beforeAll } from "bun:test";
import { getContext, runInContext, SecurityContext } from "../../src/core/context";
import { Memory } from "../../src/core/memory";

describe("Phase 109: Context Propagation", () => {
    it("should propagate SecurityContext across async boundaries", async () => {
        const testCtx: SecurityContext = {
            userId: "test-user-context",
            requestId: "test-req-123",
            isAdmin: false,
        };

        await runInContext(testCtx, async () => {
            const ctx = getContext();
            expect(ctx).toBeDefined();
            expect(ctx?.userId).toBe("test-user-context");
            expect(ctx?.requestId).toBe("test-req-123");

            // Check nested async
            await new Promise((resolve) => {
                setTimeout(() => {
                    const innerCtx = getContext();
                    expect(innerCtx?.userId).toBe("test-user-context");
                    resolve(null);
                }, 10);
            });
        });
    });

    it("should correctly handle context matching in verifyContext", async () => {
        const testCtx: SecurityContext = {
            userId: "user-a",
            requestId: "req-a",
        };

        await runInContext(testCtx, async () => {
            const { verifyContext } = await import("../../src/core/context");

            // Should allow matching userId
            expect(verifyContext("user-a")).toBe("user-a");

            // Should throw on mismatch for non-admin
            expect(() => verifyContext("user-b")).toThrow(/Unauthorized/);
        });
    });

    it("should allow mismatch for admin context and return targeted user", async () => {
        const adminCtx: SecurityContext = {
            userId: "admin-user",
            requestId: "admin-req",
            isAdmin: true,
        };

        await runInContext(adminCtx, async () => {
            const { verifyContext } = await import("../../src/core/context");
            // Admin can access anyone's data and returns THAT user's ID
            expect(verifyContext("user-any")).toBe("user-any");
            // Admin default is still admin if no arg
            expect(verifyContext(undefined)).toBe("admin-user");
        });
    });
});
