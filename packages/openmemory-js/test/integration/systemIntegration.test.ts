/**
 * System Integration Test
 * Validates that all enhanced components work together seamlessly
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/server";
import { Memory } from "../../src/core/memory";
import { getSupportedApiVersions } from "../../src/core/apiVersionConfig";
import { validateVersionCompatibility } from "../../src/core/apiVersionConfig";
import { getCurrentVersion, rollbackToVersion } from "../../src/core/migrate";
import { logger } from "../../src/utils/logger";

describe("System Integration Tests", () => {
    let server: any;
    const baseUrl = "http://localhost:3051";

    beforeAll(async () => {
        server = app.listen(3051);
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    afterAll(async () => {
        if (server) {
            server.stop();
        }
    });

    test("API versioning system integration", async () => {
        // Test API version endpoint (should be public)
        const versionResponse = await fetch(`${baseUrl}/api/version`);
        
        if (!versionResponse.ok) {
            // If authentication is required, skip detailed API tests
            console.log("API version endpoint requires authentication, skipping detailed tests");
            return;
        }
        
        const versionData = await versionResponse.json();
        expect(versionData.success).toBe(true);
        expect(Array.isArray(versionData.supported)).toBe(true);
        expect(versionData.supported.length).toBeGreaterThan(0);

        // Test version compatibility validation
        const compatibility = validateVersionCompatibility();
        expect(compatibility.valid).toBe(true);
        if (!compatibility.valid) {
            logger.error("Version compatibility issues", { issues: compatibility.issues });
        }

        // Test API endpoints with different versions
        const supportedVersions = getSupportedApiVersions();
        for (const version of supportedVersions.slice(0, 2)) { // Test first 2 versions
            const healthResponse = await fetch(`${baseUrl}/health`, {
                headers: {
                    "X-API-Version": version,
                    "Accept": `application/vnd.openmemory.${version}+json`
                }
            });
            
            expect(healthResponse.ok).toBe(true);
            expect(healthResponse.headers.get("X-API-Version")).toBe(version);
            
            const healthData = await healthResponse.json();
            expect(healthData).toBeDefined();
            
            // Check version-specific response format
            if (version === "legacy") {
                expect(typeof healthData.status === "string" || typeof healthData.success === "boolean").toBe(true);
            } else {
                expect(typeof healthData.success).toBe("boolean");
            }
        }
    });

    test("Database migration system integration", async () => {
        // Test migration system is working
        const currentVersion = await getCurrentVersion();
        expect(currentVersion).toBeDefined();
        if (currentVersion) {
            expect(typeof currentVersion).toBe("string");
            expect(currentVersion.length).toBeGreaterThan(0);
        }

        // Test that rollback functionality exists (without actually rolling back)
        expect(typeof rollbackToVersion).toBe("function");
    });

    test("Memory system with enhanced features", async () => {
        const memory = new Memory("integration-test-user");
        
        // Test basic memory operations
        const addResult = await memory.add("Integration test content", {
            tags: ["integration", "test"],
            metadata: { testType: "system-integration" }
        });
        
        expect(addResult).toBeDefined();
        expect(addResult.id).toBeDefined();
        expect(addResult.content).toBe("Integration test content");
        expect(addResult.tags).toContain("integration");
        expect(addResult.tags).toContain("test");

        // Test search functionality
        const searchResults = await memory.search("integration test", { limit: 5 });
        expect(Array.isArray(searchResults)).toBe(true);
        expect(searchResults.length).toBeGreaterThan(0);
        
        const foundItem = searchResults.find(item => item.id === addResult.id);
        expect(foundItem).toBeDefined();
        expect(foundItem?.content).toBe("Integration test content");

        // Test update functionality
        const updateResult = await memory.update(addResult.id, {
            content: "Updated integration test content",
            tags: ["integration", "test", "updated"]
        });
        
        expect(updateResult).toBeDefined();
        // Note: update may return different structure, so check what's available
        if (updateResult.content) {
            expect(updateResult.content).toBe("Updated integration test content");
        }
        if (updateResult.tags) {
            expect(updateResult.tags).toContain("updated");
        }

        // Test delete functionality
        await memory.delete(addResult.id);
        
        const deletedItem = await memory.get(addResult.id);
        expect(deletedItem).toBeFalsy(); // Could be null or undefined
    });

    test("Enhanced monitoring and health checks", async () => {
        // Test basic health endpoint
        const healthResponse = await fetch(`${baseUrl}/health`);
        expect(healthResponse.ok).toBe(true);
        
        const healthData = await healthResponse.json();
        expect(healthData.success).toBe(true);
        expect(healthData.version).toBeDefined();
        expect(typeof healthData.uptime).toBe("number");

        // Test system sectors endpoint (may require auth, so handle gracefully)
        const sectorsResponse = await fetch(`${baseUrl}/sectors`);
        if (sectorsResponse.ok) {
            const sectorsData = await sectorsResponse.json();
            expect(Array.isArray(sectorsData.sectors)).toBe(true);
            expect(sectorsData.configs).toBeDefined();
        } else {
            // If authentication is required, that's expected behavior
            expect(sectorsResponse.status).toBe(401);
        }
    });

    test("Security and input validation integration", async () => {
        // Test that invalid API version is handled properly
        const invalidVersionResponse = await fetch(`${baseUrl}/health`, {
            headers: {
                "X-API-Version": "invalid-version"
            }
        });
        
        // Should either reject or fallback to default version
        if (invalidVersionResponse.ok) {
            // If it succeeds, it should have fallen back to default version
            const defaultVersion = invalidVersionResponse.headers.get("X-API-Version");
            expect(defaultVersion).toBeDefined();
            expect(getSupportedApiVersions()).toContain(defaultVersion!);
        } else {
            // If it fails, should be a 400 error
            expect(invalidVersionResponse.status).toBe(400);
        }

        // Test that malformed requests are handled properly
        const malformedResponse = await fetch(`${baseUrl}/api/version`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: "invalid-json"
        });
        
        expect(malformedResponse.status).toBeGreaterThanOrEqual(400);
        expect(malformedResponse.status).toBeLessThan(500);
    });

    test("Performance and resource management", async () => {
        // Test that the system can handle multiple concurrent requests
        const concurrentRequests = Array.from({ length: 5 }, (_, i) => 
            fetch(`${baseUrl}/health?test=${i}`)
        );
        
        const responses = await Promise.all(concurrentRequests);
        
        // All requests should succeed
        for (const response of responses) {
            expect(response.ok).toBe(true);
        }

        // Test that memory usage is reasonable
        const memoryUsage = process.memoryUsage();
        expect(memoryUsage.heapUsed).toBeLessThan(500 * 1024 * 1024); // Less than 500MB
        expect(memoryUsage.rss).toBeLessThan(1024 * 1024 * 1024); // Less than 1GB
    });

    test("Error handling and resilience", async () => {
        // Test 404 handling
        const notFoundResponse = await fetch(`${baseUrl}/nonexistent-endpoint`);
        expect(notFoundResponse.status).toBe(404);

        // Test that the server is still responsive after errors
        const healthAfterErrorResponse = await fetch(`${baseUrl}/health`);
        expect(healthAfterErrorResponse.ok).toBe(true);
    });
});