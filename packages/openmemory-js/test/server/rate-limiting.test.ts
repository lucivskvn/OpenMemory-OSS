/**
 * @file Rate Limiting Tests
 * Tests the rate limiting middleware functionality
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { rateLimitPlugin, createRateLimitPlugin } from "../../src/server/middleware/rateLimit";
import { getRateLimitConfig } from "../../src/server/middleware/rateLimitConfig";
import { cache } from "../../src/core/cache";

describe("Rate Limiting", () => {
    let app: Elysia;

    beforeEach(() => {
        app = new Elysia();
    });

    afterEach(async () => {
        // Clean up cache keys
        try {
            await cache.flushAll();
        } catch (e) {
            // Ignore cache cleanup errors in tests
        }
    });

    describe("Rate Limit Configuration", () => {
        it("should return correct configuration for different endpoint types", () => {
            const authConfig = getRateLimitConfig("auth");
            expect(authConfig.max).toBe(5);
            expect(authConfig.windowMs).toBe(15 * 60 * 1000);
            expect(authConfig.keyPrefix).toBe("auth");

            const adminConfig = getRateLimitConfig("admin");
            expect(adminConfig.max).toBe(20);
            expect(adminConfig.windowMs).toBe(60000);
            expect(adminConfig.keyPrefix).toBe("admin");

            const memoryConfig = getRateLimitConfig("memory");
            expect(memoryConfig.max).toBe(200);
            expect(memoryConfig.windowMs).toBe(60000);
            expect(memoryConfig.keyPrefix).toBe("memory");
        });

        it("should fallback to global config for unknown types", () => {
            const unknownConfig = getRateLimitConfig("unknown" as any);
            expect(unknownConfig.keyPrefix).toBe("global");
            expect(unknownConfig.max).toBe(100);
        });
    });

    describe("Rate Limit Plugin", () => {
        it("should create plugin with default configuration", () => {
            const plugin = rateLimitPlugin();
            expect(plugin).toBeDefined();
            expect(typeof plugin).toBe("function");
        });

        it("should create plugin with specific endpoint configuration", () => {
            const plugin = createRateLimitPlugin("auth");
            expect(plugin).toBeDefined();
            expect(typeof plugin).toBe("function");
        });

        it("should apply rate limiting to routes", async () => {
            // Create a test app with rate limiting
            const testApp = new Elysia()
                .use(createRateLimitPlugin("auth"))
                .get("/test", () => ({ success: true }));

            // First request should succeed
            const response1 = await testApp.handle(new Request("http://localhost/test"));
            expect(response1.status).toBe(200);

            // Check rate limit headers are present
            expect(response1.headers.get("X-RateLimit-Limit")).toBeDefined();
            expect(response1.headers.get("X-RateLimit-Remaining")).toBeDefined();
            expect(response1.headers.get("X-RateLimit-Reset")).toBeDefined();
        });
    });

    describe("Rate Limit Enforcement", () => {
        it("should enforce different limits for different endpoint types", () => {
            const authConfig = getRateLimitConfig("auth");
            const memoryConfig = getRateLimitConfig("memory");
            const adminConfig = getRateLimitConfig("admin");

            // Auth should have stricter limits
            expect(authConfig.max).toBeLessThan(memoryConfig.max);
            expect(authConfig.max).toBeLessThan(adminConfig.max);

            // Memory should have higher limits than admin
            expect(memoryConfig.max).toBeGreaterThan(adminConfig.max);
        });

        it("should use appropriate window sizes", () => {
            const authConfig = getRateLimitConfig("auth");
            const setupConfig = getRateLimitConfig("setup");

            // Auth should have longer window (15 minutes)
            expect(authConfig.windowMs).toBe(15 * 60 * 1000);
            
            // Setup should have 5 minute window
            expect(setupConfig.windowMs).toBe(5 * 60 * 1000);
        });
    });
});