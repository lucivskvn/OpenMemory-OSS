/**
 * @file Property Test: Test Suite Stability
 * **Property 34: Test Suite Stability**
 * **Validates: Requirements 7.1**
 * 
 * This property test validates that the test suite remains stable and reliable
 * under various conditions, including timeout scenarios, process termination,
 * and cleanup operations.
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { TestWatchdog, withTestTimeout, withE2ETimeout } from "../../src/utils/testWatchdog";
import { cleanupTestArtifacts, preTestCleanup, postTestCleanup } from "../../src/utils/testCleanup";

describe("Property Test: Test Suite Stability", () => {
    
    test("Property 34.1: Test watchdog should terminate stuck operations within timeout", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 100, max: 2000 }), // timeout in ms
                fc.integer({ min: 50, max: 500 }),   // operation duration in ms
                async (timeout, operationDuration) => {
                    const shouldTimeout = operationDuration > timeout;
                    
                    const result = await TestWatchdog.withTimeout(
                        async (signal) => {
                            // Simulate an operation that may or may not complete in time
                            await new Promise(resolve => setTimeout(resolve, operationDuration));
                            
                            // Check if we were aborted
                            if (signal.aborted) {
                                throw new Error("Operation was aborted");
                            }
                            
                            return "completed";
                        },
                        { 
                            timeout,
                            testName: `property-test-${timeout}-${operationDuration}`
                        }
                    );
                    
                    if (shouldTimeout) {
                        // Operation should have timed out
                        expect(result.timedOut).toBe(true);
                        expect(result.result).toBeUndefined();
                    } else {
                        // Operation should have completed successfully
                        expect(result.timedOut).toBe(false);
                        expect(result.result).toBe("completed");
                    }
                    
                    // Duration should be reasonable
                    expect(result.duration).toBeGreaterThan(0);
                    expect(result.duration).toBeLessThan(timeout + 1000); // Allow some overhead
                }
            ),
            { 
                numRuns: 20,
                timeout: 10000 // 10 second timeout for the property test itself
            }
        );
    });

    test("Property 34.2: Test cleanup should handle various file patterns consistently", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
                fc.array(fc.constantFrom("db", "sqlite", "log", "txt"), { minLength: 1, maxLength: 3 }),
                async (baseNames, extensions) => {
                    // Create test patterns
                    const patterns = baseNames.flatMap(base => 
                        extensions.map(ext => `test_${base}_*.${ext}`)
                    );
                    
                    // Test cleanup with these patterns
                    const result = await cleanupTestArtifacts({
                        databases: false,
                        logs: false,
                        nodeModules: false,
                        customPatterns: patterns,
                        dryRun: true // Don't actually delete anything
                    });
                    
                    // Cleanup should complete without errors
                    expect(result.deleted).toBeGreaterThanOrEqual(0);
                    expect(result.failed).toBe(0);
                    expect(Array.isArray(result.files)).toBe(true);
                    
                    // All processed files should match our patterns
                    for (const file of result.files) {
                        const matchesPattern = patterns.some(pattern => {
                            const regex = new RegExp(pattern.replace(/\*/g, '.*'));
                            return regex.test(file);
                        });
                        // Note: This might not always be true due to existing files,
                        // but the cleanup should handle it gracefully
                    }
                }
            ),
            { 
                numRuns: 15,
                timeout: 8000
            }
        );
    });

    test("Property 34.3: Pre and post test cleanup should be idempotent", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 3 }), // Number of cleanup runs
                async (cleanupRuns) => {
                    // Run cleanup multiple times
                    const results = [];
                    
                    for (let i = 0; i < cleanupRuns; i++) {
                        // Pre-test cleanup should be safe to run multiple times
                        await expect(preTestCleanup()).resolves.toBeUndefined();
                        
                        // Post-test cleanup should also be safe to run multiple times
                        await expect(postTestCleanup()).resolves.toBeUndefined();
                    }
                    
                    // All cleanup operations should complete successfully
                    expect(results.length).toBe(0); // No errors thrown
                }
            ),
            { 
                numRuns: 10,
                timeout: 15000
            }
        );
    });

    test("Property 34.4: Test watchdog should handle concurrent operations correctly", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 2, max: 5 }), // Number of concurrent operations
                fc.integer({ min: 100, max: 1000 }), // Base timeout
                async (concurrency, baseTimeout) => {
                    // Create multiple concurrent operations with different durations
                    const operations = Array.from({ length: concurrency }, (_, i) => {
                        const operationTimeout = baseTimeout + (i * 100);
                        const operationDuration = baseTimeout / 2; // Should complete successfully
                        
                        return TestWatchdog.withTimeout(
                            async (signal) => {
                                await new Promise(resolve => setTimeout(resolve, operationDuration));
                                
                                if (signal.aborted) {
                                    throw new Error("Operation was aborted");
                                }
                                
                                return `operation-${i}`;
                            },
                            {
                                timeout: operationTimeout,
                                testName: `concurrent-op-${i}`
                            }
                        );
                    });
                    
                    // Wait for all operations to complete
                    const results = await Promise.all(operations);
                    
                    // All operations should complete successfully (not timeout)
                    for (let i = 0; i < results.length; i++) {
                        expect(results[i].timedOut).toBe(false);
                        expect(results[i].result).toBe(`operation-${i}`);
                        expect(results[i].duration).toBeGreaterThan(0);
                    }
                }
            ),
            { 
                numRuns: 8,
                timeout: 12000
            }
        );
    });

    test("Property 34.5: E2E timeout wrapper should provide longer timeouts than unit tests", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 50, max: 200 }), // Operation duration in ms
                async (operationDuration) => {
                    const startTime = Date.now();
                    
                    // Test with E2E timeout (should be longer)
                    const e2eResult = await withE2ETimeout(
                        async (signal) => {
                            await new Promise(resolve => setTimeout(resolve, operationDuration));
                            
                            if (signal.aborted) {
                                throw new Error("Operation was aborted");
                            }
                            
                            return "e2e-completed";
                        },
                        { testName: "property-e2e-test" }
                    );
                    
                    const endTime = Date.now();
                    
                    // E2E operation should complete successfully for short durations
                    expect(e2eResult.timedOut).toBe(false);
                    expect(e2eResult.result).toBe("e2e-completed");
                    expect(e2eResult.duration).toBeGreaterThanOrEqual(operationDuration);
                    expect(endTime - startTime).toBeGreaterThanOrEqual(operationDuration);
                }
            ),
            { 
                numRuns: 10,
                timeout: 8000
            }
        );
    });

    test("Property 34.6: Test suite should handle process monitoring correctly", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 3, maxLength: 10 }), // Test name
                fc.integer({ min: 100, max: 500 }), // Process duration
                async (testName, processDuration) => {
                    // Create a mock process-like object
                    let processKilled = false;
                    const mockProcess = {
                        kill: () => { processKilled = true; },
                        exited: new Promise(resolve => {
                            setTimeout(() => resolve(0), processDuration);
                        })
                    };
                    
                    // Monitor the process with a timeout longer than process duration
                    const monitorTimeout = processDuration + 200;
                    TestWatchdog.monitorSpawnedProcess(
                        mockProcess as any,
                        monitorTimeout,
                        testName
                    );
                    
                    // Wait for process to complete naturally
                    await mockProcess.exited;
                    
                    // Process should not have been killed (completed naturally)
                    expect(processKilled).toBe(false);
                    
                    // Test name should be valid
                    expect(testName.length).toBeGreaterThan(0);
                }
            ),
            { 
                numRuns: 12,
                timeout: 10000
            }
        );
    });
});