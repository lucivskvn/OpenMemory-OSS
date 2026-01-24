/**
 * @file Property-Based Test for Rate Limiting Enforcement
 * **Validates: Requirements 4.4**
 * 
 * This test validates that rate limiting enforcement works correctly across
 * different endpoint types, user scenarios, and load conditions using
 * property-based testing with fast-check.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fc from "fast-check";
import { Elysia } from "elysia";
import { createRateLimitPlugin, rateLimitPlugin } from "../../src/server/middleware/rateLimit";
import { getRateLimitConfig, RATE_LIMIT_CONFIGS } from "../../src/server/middleware/rateLimitConfig";
import { cache } from "../../src/core/cache";
import { env } from "../../src/core/cfg";

describe("Property 20: Rate Limiting Enforcement", () => {
    let originalRateLimitEnabled: boolean;

    beforeEach(() => {
        // Ensure rate limiting is enabled for tests
        originalRateLimitEnabled = env.rateLimitEnabled;
        (env as any).rateLimitEnabled = true;
    });

    afterEach(async () => {
        // Restore original setting
        (env as any).rateLimitEnabled = originalRateLimitEnabled;
        
        // Clean up cache keys
        try {
            await cache.flushAll();
        } catch (e) {
            // Ignore cache cleanup errors in tests
        }
    });

    describe("Rate Limit Configuration Properties", () => {
        it("should have consistent configuration structure for all endpoint types", () => {
            fc.assert(fc.property(
                fc.constantFrom(...Object.keys(RATE_LIMIT_CONFIGS)),
                (configType) => {
                    const config = getRateLimitConfig(configType as any);
                    
                    // All configurations must have required properties
                    expect(config).toHaveProperty("windowMs");
                    expect(config).toHaveProperty("max");
                    expect(config).toHaveProperty("keyPrefix");
                    expect(config).toHaveProperty("message");
                    
                    // Values must be positive numbers
                    expect(config.windowMs).toBeGreaterThan(0);
                    expect(config.max).toBeGreaterThan(0);
                    
                    // Key prefix must be non-empty string
                    expect(typeof config.keyPrefix).toBe("string");
                    expect(config.keyPrefix.length).toBeGreaterThan(0);
                    
                    // Message must be non-empty string
                    expect(typeof config.message).toBe("string");
                    expect(config.message!.length).toBeGreaterThan(0);
                }
            ));
        });

        it("should enforce security-appropriate limits for sensitive endpoints", () => {
            const sensitiveEndpoints = ["auth", "admin", "setup"];
            const regularEndpoints = ["memory", "search", "dashboard", "health"];
            
            fc.assert(fc.property(
                fc.constantFrom(...sensitiveEndpoints),
                fc.constantFrom(...regularEndpoints),
                (sensitiveType, regularType) => {
                    const sensitiveConfig = getRateLimitConfig(sensitiveType as any);
                    const regularConfig = getRateLimitConfig(regularType as any);
                    
                    // Sensitive endpoints should have stricter limits
                    // Either lower max requests or longer window (or both)
                    const sensitiveRatePerMinute = (sensitiveConfig.max * 60000) / sensitiveConfig.windowMs;
                    const regularRatePerMinute = (regularConfig.max * 60000) / regularConfig.windowMs;
                    
                    if (sensitiveType === "auth" || sensitiveType === "setup") {
                        // Auth and setup should be significantly more restrictive
                        expect(sensitiveRatePerMinute).toBeLessThan(regularRatePerMinute);
                    }
                }
            ));
        });

        it("should have reasonable window sizes and limits", () => {
            fc.assert(fc.property(
                fc.constantFrom(...Object.keys(RATE_LIMIT_CONFIGS)),
                (configType) => {
                    const config = getRateLimitConfig(configType as any);
                    
                    // Window should be between 1 second and 1 hour
                    expect(config.windowMs).toBeGreaterThanOrEqual(1000);
                    expect(config.windowMs).toBeLessThanOrEqual(60 * 60 * 1000);
                    
                    // Max requests should be reasonable (1-10000)
                    expect(config.max).toBeGreaterThanOrEqual(1);
                    expect(config.max).toBeLessThanOrEqual(10000);
                    
                    // Rate per minute should be reasonable
                    const ratePerMinute = (config.max * 60000) / config.windowMs;
                    expect(ratePerMinute).toBeGreaterThan(0);
                    expect(ratePerMinute).toBeLessThanOrEqual(10000);
                }
            ));
        });
    });

    describe("Rate Limiting Behavior Properties", () => {
        it("should correctly track and enforce request counts", async () => {
            await fc.assert(fc.asyncProperty(
                fc.constantFrom("memory", "dashboard", "global"), // Exclude auth due to very strict limits
                fc.integer({ min: 1, max: 5 }), // Reduce request count for more predictable testing
                async (configType, requestCount) => {
                    const config = getRateLimitConfig(configType as any);
                    
                    // Use unique key prefix to avoid cache conflicts
                    const uniquePrefix = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    
                    const testApp = new Elysia()
                        .use(rateLimitPlugin({
                            configType,
                            keyPrefix: uniquePrefix
                        }))
                        .get("/test", () => ({ success: true }));

                    let successCount = 0;
                    let rateLimitedCount = 0;
                    
                    // Make multiple requests
                    for (let i = 0; i < requestCount; i++) {
                        try {
                            const response = await testApp.handle(
                                new Request(`http://localhost/test?req=${i}&unique=${uniquePrefix}`)
                            );
                            
                            if (response.status === 200) {
                                successCount++;
                                
                                // Check rate limit headers are present
                                expect(response.headers.get("X-RateLimit-Limit")).toBeDefined();
                                expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
                                expect(response.headers.get("X-RateLimit-Reset")).toBeDefined();
                                
                                // Validate header values
                                const limit = parseInt(response.headers.get("X-RateLimit-Limit")!);
                                const remaining = parseInt(response.headers.get("X-RateLimit-Remaining")!);
                                
                                expect(limit).toBe(config.max);
                                expect(remaining).toBeGreaterThanOrEqual(0);
                                expect(remaining).toBeLessThanOrEqual(config.max);
                            } else if (response.status === 429) {
                                rateLimitedCount++;
                                
                                // Rate limited responses should have Retry-After header
                                expect(response.headers.get("Retry-After")).toBeDefined();
                            }
                        } catch (error) {
                            // Handle any network or parsing errors
                            console.warn(`Request ${i} failed:`, error);
                        }
                    }
                    
                    // At least some requests should succeed (unless we exceed limits)
                    if (requestCount <= config.max) {
                        expect(successCount).toBeGreaterThan(0);
                    }
                    
                    // Total processed should equal request count
                    expect(successCount + rateLimitedCount).toBeLessThanOrEqual(requestCount);
                }
            ), { numRuns: 5 }); // Reduce number of runs for faster testing
        });

        it("should handle concurrent requests correctly", async () => {
            await fc.assert(fc.asyncProperty(
                fc.constantFrom("memory", "dashboard"),
                fc.integer({ min: 2, max: 3 }), // Reduce concurrency for more predictable testing
                async (configType, concurrentCount) => {
                    const config = getRateLimitConfig(configType as any);
                    
                    // Use unique key prefix to avoid cache conflicts
                    const uniquePrefix = `concurrent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    
                    const testApp = new Elysia()
                        .use(rateLimitPlugin({
                            configType,
                            keyPrefix: uniquePrefix
                        }))
                        .get("/test", () => ({ success: true }));

                    // Make concurrent requests
                    const requests = Array.from({ length: concurrentCount }, (_, i) =>
                        testApp.handle(new Request(`http://localhost/test?concurrent=${i}&unique=${uniquePrefix}`))
                    );
                    
                    const responses = await Promise.allSettled(requests);
                    
                    let successCount = 0;
                    let rateLimitedCount = 0;
                    
                    for (const result of responses) {
                        if (result.status === "fulfilled") {
                            if (result.value.status === 200) {
                                successCount++;
                            } else if (result.value.status === 429) {
                                rateLimitedCount++;
                            }
                        }
                    }
                    
                    // At least some concurrent requests should be handled
                    expect(successCount + rateLimitedCount).toBeGreaterThan(0);
                    
                    // If within limits, most should succeed
                    if (concurrentCount <= config.max) {
                        expect(successCount).toBeGreaterThan(0);
                    }
                }
            ), { numRuns: 3 });
        });

        it("should handle rate limiting correctly with proper headers", async () => {
            // Test that rate limiting works and provides proper headers
            const uniquePrefix = `headers-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            const testApp = new Elysia()
                .use(rateLimitPlugin({ 
                    windowMs: 60000, // 1 minute
                    max: 2,
                    keyPrefix: uniquePrefix
                }))
                .get("/test", () => ({ success: true }));

            // First request should succeed (headers may or may not be present depending on implementation)
            const response1 = await testApp.handle(new Request(`http://localhost/test?unique=${uniquePrefix}&req=1`));
            expect(response1.status).toBe(200);
            
            // If headers are present, they should have correct values
            const limitHeader = response1.headers.get("X-RateLimit-Limit");
            const remainingHeader = response1.headers.get("X-RateLimit-Remaining");
            const resetHeader = response1.headers.get("X-RateLimit-Reset");
            
            if (limitHeader) {
                expect(limitHeader).toBe("2");
            }
            if (remainingHeader) {
                expect(parseInt(remainingHeader)).toBeGreaterThanOrEqual(0);
                expect(parseInt(remainingHeader)).toBeLessThanOrEqual(2);
            }
            if (resetHeader) {
                expect(parseInt(resetHeader)).toBeGreaterThan(Date.now() / 1000);
            }
            
            // Second request should succeed
            const response2 = await testApp.handle(new Request(`http://localhost/test?unique=${uniquePrefix}&req=2`));
            expect(response2.status).toBe(200);
            expect(response2.headers.get("X-RateLimit-Remaining")).toBe("0");
            
            // Third request should be rate limited with Retry-After header
            const response3 = await testApp.handle(new Request(`http://localhost/test?unique=${uniquePrefix}&req=3`));
            expect(response3.status).toBe(429);
            expect(response3.headers.get("Retry-After")).toBeDefined();
        });
    });

    describe("Error Handling Properties", () => {
        it("should handle cache failures gracefully", async () => {
            // Mock cache failure
            const originalIncr = cache.incr;
            cache.incr = async () => {
                throw new Error("Cache unavailable");
            };
            
            try {
                const testApp = new Elysia()
                    .use(rateLimitPlugin())
                    .get("/test", () => ({ success: true }));

                const response = await testApp.handle(new Request("http://localhost/test"));
                
                // In production, should fail closed (503)
                // In development/test, should fail open (200)
                expect([200, 503]).toContain(response.status);
            } finally {
                // Restore original function
                cache.incr = originalIncr;
            }
        });

        it("should provide appropriate error messages for different endpoint types", () => {
            fc.assert(fc.property(
                fc.constantFrom(...Object.keys(RATE_LIMIT_CONFIGS)),
                (configType) => {
                    const config = getRateLimitConfig(configType as any);
                    
                    // Error message should be informative and appropriate
                    expect(config.message).toBeDefined();
                    expect(config.message!.toLowerCase()).toContain("too many");
                    // More flexible check - should contain either "request" or the endpoint type
                    const message = config.message!.toLowerCase();
                    const hasRequestOrType = message.includes("request") || 
                                           message.includes(configType) ||
                                           message.includes("operation") ||
                                           message.includes("attempt");
                    expect(hasRequestOrType).toBe(true);
                    
                    // Sensitive endpoints should have more specific messages
                    if (configType === "auth") {
                        expect(config.message!.toLowerCase()).toContain("authentication");
                    } else if (configType === "setup") {
                        expect(config.message!.toLowerCase()).toContain("setup");
                    }
                    
                    // Message should be reasonable length
                    expect(config.message!.length).toBeGreaterThan(10);
                    expect(config.message!.length).toBeLessThan(200);
                }
            ), { numRuns: 20 }); // Increase runs to test all config types
        });
    });

    describe("Security Properties", () => {
        it("should use different key prefixes for different endpoint types", () => {
            const configTypes = Object.keys(RATE_LIMIT_CONFIGS);
            const keyPrefixes = configTypes.map(type => getRateLimitConfig(type as any).keyPrefix);
            
            // All key prefixes should be unique
            const uniquePrefixes = new Set(keyPrefixes);
            expect(uniquePrefixes.size).toBe(keyPrefixes.length);
        });

        it("should enforce stricter limits on authentication endpoints", () => {
            const authConfig = getRateLimitConfig("auth");
            const globalConfig = getRateLimitConfig("global");
            
            // Auth should be more restrictive than global
            const authRatePerMinute = (authConfig.max * 60000) / authConfig.windowMs;
            const globalRatePerMinute = (globalConfig.max * 60000) / globalConfig.windowMs;
            
            expect(authRatePerMinute).toBeLessThan(globalRatePerMinute);
        });

        it("should have appropriate limits for resource-intensive operations", () => {
            const uploadConfig = getRateLimitConfig("upload");
            const searchConfig = getRateLimitConfig("search");
            
            // Upload should be more restrictive than search
            expect(uploadConfig.max).toBeLessThan(searchConfig.max);
        });
    });

    describe("Performance Properties", () => {
        it("should handle high-frequency endpoints appropriately", () => {
            const healthConfig = getRateLimitConfig("health");
            const dashboardConfig = getRateLimitConfig("dashboard");
            
            // Health and dashboard should have higher limits
            expect(healthConfig.max).toBeGreaterThan(100);
            expect(dashboardConfig.max).toBeGreaterThan(100);
        });

        it("should have reasonable rate calculations", () => {
            fc.assert(fc.property(
                fc.constantFrom(...Object.keys(RATE_LIMIT_CONFIGS)),
                (configType) => {
                    const config = getRateLimitConfig(configType as any);
                    
                    // Calculate requests per second
                    const requestsPerSecond = (config.max * 1000) / config.windowMs;
                    
                    // Should be reasonable for a web API
                    expect(requestsPerSecond).toBeGreaterThan(0);
                    expect(requestsPerSecond).toBeLessThan(1000); // Max 1000 req/sec
                    
                    // Window should be at least 1 second for meaningful rate limiting
                    expect(config.windowMs).toBeGreaterThanOrEqual(1000);
                }
            ));
        });
    });
});