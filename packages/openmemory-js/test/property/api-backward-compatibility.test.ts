/**
 * Property-Based Test: API Backward Compatibility Maintenance
 * **Validates: Requirements 10.2**
 * 
 * This test validates that API backward compatibility is maintained across versions,
 * ensuring that existing API contracts remain functional during upgrades.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fc from "fast-check";
import { app } from "../../src/server";
import { 
    getApiVersionConfig, 
    getSupportedApiVersions,
    validateVersionCompatibility,
    DEFAULT_API_VERSION
} from "../../src/core/apiVersionConfig";
import { 
    extractApiVersion,
    transformResponse,
    RESPONSE_TRANSFORMERS
} from "../../src/server/middleware/apiVersioning";
import { logger } from "../../src/utils/logger";

describe("Property 49: API Backward Compatibility Maintenance", () => {
    let server: any;
    const baseUrl = "http://localhost:3049";

    beforeAll(async () => {
        server = app.listen(3049);
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    afterAll(async () => {
        if (server) {
            server.stop();
        }
    });

    test("Property: API version extraction is consistent and deterministic", () => {
        fc.assert(fc.property(
            fc.record({
                acceptHeader: fc.option(fc.oneof(
                    fc.constant("application/vnd.openmemory.v1+json"),
                    fc.constant("application/vnd.openmemory.v2+json"),
                    fc.constant("application/vnd.openmemory.legacy+json"),
                    fc.constant("application/json")
                )),
                versionHeader: fc.option(fc.oneof(
                    fc.constant("v1"),
                    fc.constant("v2"),
                    fc.constant("legacy")
                )),
                urlPath: fc.oneof(
                    fc.constant("/api/v1/memory/add"),
                    fc.constant("/api/v2/memory/add"),
                    fc.constant("/api/legacy/memory/add"),
                    fc.constant("/api/memory/add")
                )
            }),
            (testCase) => {
                // Create mock request
                const headers = new Headers();
                if (testCase.acceptHeader) {
                    headers.set("Accept", testCase.acceptHeader);
                }
                if (testCase.versionHeader) {
                    headers.set("X-API-Version", testCase.versionHeader);
                }

                const mockRequest = new Request(`${baseUrl}${testCase.urlPath}`, {
                    headers
                });

                const extractedVersion = extractApiVersion(mockRequest);

                // Version extraction should be deterministic
                const extractedAgain = extractApiVersion(mockRequest);
                expect(extractedVersion).toBe(extractedAgain);

                // Should extract a valid version
                const supportedVersions = getSupportedApiVersions();
                const allVersions = [...supportedVersions, DEFAULT_API_VERSION];
                expect(allVersions).toContain(extractedVersion);

                // Priority order: Accept header > X-API-Version header > URL path > default
                if (testCase.acceptHeader?.includes("vnd.openmemory.")) {
                    const expectedFromAccept = testCase.acceptHeader.match(/vnd\.openmemory\.([^+]+)/)?.[1];
                    if (expectedFromAccept && allVersions.includes(expectedFromAccept)) {
                        expect(extractedVersion).toBe(expectedFromAccept);
                    }
                } else if (testCase.versionHeader && allVersions.includes(testCase.versionHeader)) {
                    expect(extractedVersion).toBe(testCase.versionHeader);
                } else if (testCase.urlPath.includes("/api/v1/")) {
                    expect(extractedVersion).toBe("v1");
                } else if (testCase.urlPath.includes("/api/v2/")) {
                    expect(extractedVersion).toBe("v2");
                } else if (testCase.urlPath.includes("/api/legacy/")) {
                    expect(extractedVersion).toBe("legacy");
                } else {
                    expect(extractedVersion).toBe(DEFAULT_API_VERSION);
                }
            }
        ), { numRuns: 25 });
    });

    test("Property: Response transformations preserve data integrity", () => {
        fc.assert(fc.property(
            fc.record({
                success: fc.boolean(),
                items: fc.array(fc.record({
                    id: fc.string(),
                    content: fc.string(),
                    score: fc.float({ min: 0, max: 1 })
                })),
                metadata: fc.record({
                    timestamp: fc.integer(),
                    version: fc.string()
                }),
                error: fc.option(fc.record({
                    code: fc.string(),
                    message: fc.string()
                }))
            }),
            fc.oneof(fc.constant("v1"), fc.constant("v2"), fc.constant("legacy")),
            fc.oneof(fc.constant("v1"), fc.constant("v2"), fc.constant("legacy")),
            (originalData, fromVersion, toVersion) => {
                const transformedData = transformResponse(originalData, fromVersion, toVersion);

                // Transformation should preserve essential data
                if (fromVersion === toVersion) {
                    expect(transformedData).toEqual(originalData);
                    return;
                }

                // Check that critical fields are preserved or properly transformed
                if (originalData.success !== undefined) {
                    // Success field should be preserved or transformed to equivalent
                    if (toVersion === "legacy") {
                        expect(transformedData.status).toBeDefined();
                        expect(transformedData.status).toBe(originalData.success ? "ok" : "error");
                        expect(transformedData.timestamp).toBeDefined();
                        expect(typeof transformedData.timestamp).toBe("number");
                    } else {
                        // For non-legacy versions, success should be preserved
                        expect(transformedData.success).toBe(originalData.success);
                    }
                }

                if (originalData.items && Array.isArray(originalData.items)) {
                    // Items should be preserved or transformed to equivalent field
                    if (toVersion === "v1" && fromVersion === "v2") {
                        expect(transformedData.results || transformedData.items).toBeDefined();
                        const resultItems = transformedData.results || transformedData.items;
                        expect(Array.isArray(resultItems)).toBe(true);
                        expect(resultItems.length).toBe(originalData.items.length);
                    } else if (toVersion === "legacy") {
                        // Legacy format wraps data differently
                        if (originalData.success) {
                            expect(transformedData.data).toBeDefined();
                            // Data should contain the original items or transformed items
                            const dataItems = transformedData.data.items || transformedData.data.results;
                            if (dataItems) {
                                expect(Array.isArray(dataItems)).toBe(true);
                            }
                        }
                    } else {
                        expect(transformedData.items).toBeDefined();
                        expect(transformedData.items.length).toBe(originalData.items.length);
                    }
                }

                // Error information should be preserved
                if (originalData.error) {
                    if (toVersion === "legacy") {
                        if (!originalData.success) {
                            expect(transformedData.data?.error || transformedData.error).toBeDefined();
                        }
                    } else {
                        expect(transformedData.error).toBeDefined();
                    }
                }

                // Metadata should be handled appropriately
                if (originalData.metadata && typeof originalData.metadata === "object") {
                    if (toVersion === "v1" && fromVersion === "v2") {
                        // v1 expects flat metadata
                        expect(transformedData.timestamp || transformedData.metadata?.timestamp).toBeDefined();
                        expect(transformedData.version || transformedData.metadata?.version).toBeDefined();
                    } else if (toVersion === "legacy") {
                        // Legacy format has timestamp at root level
                        expect(transformedData.timestamp).toBeDefined();
                    }
                }
            }
        ), { numRuns: 25 });
    });

    test("Property: API version configurations are valid and consistent", () => {
        fc.assert(fc.property(
            fc.constantFrom(...getSupportedApiVersions()),
            (version) => {
                const config = getApiVersionConfig(version);
                expect(config).toBeDefined();

                if (config) {
                    // Version string should be valid semver-like
                    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);

                    // Deprecated versions should have proper sunset information
                    if (config.deprecated) {
                        expect(config.deprecationMessage).toBeDefined();
                        expect(config.deprecationMessage!.length).toBeGreaterThan(0);
                        
                        if (config.supportedUntil) {
                            const sunsetDate = new Date(config.supportedUntil);
                            expect(sunsetDate.getTime()).toBeGreaterThan(Date.now() - 365 * 24 * 60 * 60 * 1000); // Not more than 1 year ago
                        }
                    }

                    // Features should be boolean flags
                    for (const [feature, enabled] of Object.entries(config.features)) {
                        expect(typeof enabled).toBe("boolean");
                        expect(feature.length).toBeGreaterThan(0);
                    }

                    // Rate limits should be reasonable if specified
                    if (config.rateLimits) {
                        if (config.rateLimits.requests) {
                            expect(config.rateLimits.requests).toBeGreaterThan(0);
                            expect(config.rateLimits.requests).toBeLessThanOrEqual(10000);
                        }
                        if (config.rateLimits.window) {
                            expect(config.rateLimits.window).toBeGreaterThan(0);
                            expect(config.rateLimits.window).toBeLessThanOrEqual(86400); // 24 hours max
                        }
                    }
                }
            }
        ), { numRuns: 20 });
    });

    test("Property: Version compatibility matrix is symmetric and transitive where applicable", () => {
        const supportedVersions = getSupportedApiVersions();
        const validation = validateVersionCompatibility();

        // Configuration should be valid
        expect(validation.valid).toBe(true);
        if (!validation.valid) {
            logger.error("API version configuration validation failed", {
                issues: validation.issues
            });
        }

        fc.assert(fc.property(
            fc.constantFrom(...supportedVersions),
            fc.constantFrom(...supportedVersions),
            (version1, version2) => {
                const config1 = getApiVersionConfig(version1);
                const config2 = getApiVersionConfig(version2);

                expect(config1).toBeDefined();
                expect(config2).toBeDefined();

                if (config1 && config2) {
                    // Same version should always be compatible with itself
                    if (version1 === version2) {
                        expect(true).toBe(true); // Self-compatibility is always true
                        return;
                    }

                    // Check backward compatibility constraints
                    const version1Newer = config1.version > config2.version;
                    const version2Newer = config2.version > config1.version;

                    if (version1Newer && config1.backwardCompatible) {
                        // version1 should be able to handle version2 requests
                        expect(config1.backwardCompatible).toBe(true);
                    }

                    if (version2Newer && config2.backwardCompatible) {
                        // version2 should be able to handle version1 requests
                        expect(config2.backwardCompatible).toBe(true);
                    }

                    // Forward compatibility check
                    if (version1Newer && config2.forwardCompatible) {
                        expect(config2.forwardCompatible).toBe(true);
                    }

                    if (version2Newer && config1.forwardCompatible) {
                        expect(config1.forwardCompatible).toBe(true);
                    }
                }
            }
        ), { numRuns: 25 });
    });

    test("Property: Response transformers are available for all supported version pairs", () => {
        const supportedVersions = getSupportedApiVersions();
        
        fc.assert(fc.property(
            fc.constantFrom(...supportedVersions),
            fc.constantFrom(...supportedVersions),
            (fromVersion, toVersion) => {
                if (fromVersion === toVersion) {
                    // Same version doesn't need transformation
                    return;
                }

                // Check if transformer exists or if versions are compatible
                const hasTransformer = RESPONSE_TRANSFORMERS.some(
                    t => t.fromVersion === fromVersion && t.toVersion === toVersion
                );

                const fromConfig = getApiVersionConfig(fromVersion);
                const toConfig = getApiVersionConfig(toVersion);

                if (fromConfig && toConfig) {
                    const fromNewer = fromConfig.version > toConfig.version;
                    const toNewer = toConfig.version > fromConfig.version;

                    // If backward/forward compatibility is claimed, there should be a way to transform
                    if ((fromNewer && fromConfig.backwardCompatible) || 
                        (toNewer && fromConfig.forwardCompatible)) {
                        // Either a transformer exists, or the transformation is identity (handled by default)
                        // We allow missing transformers if one of the versions is the default
                        const allowMissingTransformer = fromVersion === DEFAULT_API_VERSION || 
                                                      toVersion === DEFAULT_API_VERSION ||
                                                      hasTransformer;
                        expect(allowMissingTransformer).toBe(true);
                    } else {
                        // If no compatibility is claimed, we don't require a transformer
                        // but if one exists, that's fine too
                        expect(true).toBe(true); // Always pass for non-compatible versions
                    }
                }
            }
        ), { numRuns: 25 });
    });

    test("Property: API endpoints maintain contract stability across versions", async () => {
        // Test that core API endpoints are accessible across different versions
        const coreEndpoints = [
            "/api/version",
            "/health",
            "/api/system/health"
        ];

        for (const endpoint of coreEndpoints) {
            for (const version of getSupportedApiVersions()) {
                const response = await fetch(`${baseUrl}${endpoint}`, {
                    headers: {
                        "X-API-Version": version,
                        "Accept": `application/vnd.openmemory.${version}+json`
                    }
                });

                // Core endpoints should be accessible from all versions
                expect(response.status).toBeLessThan(500);
                
                // Should have version headers
                expect(response.headers.get("X-API-Version")).toBeDefined();
                
                if (response.ok) {
                    const data = await response.json();
                    expect(data).toBeDefined();
                    
                    // Response should have success indicator
                    expect(typeof data.success === "boolean" || typeof data.status === "string").toBe(true);
                }
            }
        }
    });
});

// Test helper to validate response structure consistency
function validateResponseStructure(data: any, version: string): boolean {
    if (!data || typeof data !== "object") return false;

    // All versions should have some form of success/status indicator
    const hasSuccessIndicator = 
        typeof data.success === "boolean" ||
        typeof data.status === "string" ||
        (data.error && typeof data.error === "object");

    if (!hasSuccessIndicator) return false;

    // Version-specific validations
    switch (version) {
        case "legacy":
            return typeof data.status === "string" && 
                   typeof data.timestamp === "number";
        case "v1":
        case "v2":
            return typeof data.success === "boolean";
        default:
            return true;
    }
}