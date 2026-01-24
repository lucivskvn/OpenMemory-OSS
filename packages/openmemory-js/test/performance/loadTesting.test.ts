/**
 * @file Load Testing Infrastructure for OpenMemory API Endpoints
 * **Requirements: 3.5, 7.4**
 * 
 * This module provides comprehensive load testing capabilities including:
 * - API endpoint load testing scenarios
 * - Memory leak detection during load
 * - Performance regression detection
 * - Concurrent user simulation
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fc from "fast-check";
import { runWithWatchdog } from "../../src/utils/testWatchdog";
import { waitForDb, closeDb } from "../../src/core/db";
import { queryPerformanceMonitor } from "../../src/core/queryOptimizer";

// Load testing configuration
const LOAD_TEST_CONFIG = {
    // Concurrent user simulation
    CONCURRENT_USERS: 10,
    REQUESTS_PER_USER: 20,
    
    // Performance thresholds
    MAX_RESPONSE_TIME: 1000,        // 1 second max response time
    MAX_ERROR_RATE: 0.05,           // 5% max error rate
    MIN_THROUGHPUT: 50,             // 50 requests per second minimum
    
    // Memory leak detection
    MAX_MEMORY_GROWTH: 50 * 1024 * 1024,  // 50MB max memory growth
    MEMORY_SAMPLE_INTERVAL: 100,           // Sample every 100ms
    
    // Performance regression
    BASELINE_RESPONSE_TIME: 100,    // 100ms baseline
    REGRESSION_THRESHOLD: 1.5,      // 50% increase is regression
    
    // Test duration
    LOAD_TEST_DURATION: 5000,      // 5 seconds
    WARMUP_DURATION: 1000,         // 1 second warmup
};

interface LoadTestResult {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    maxResponseTime: number;
    minResponseTime: number;
    throughput: number;
    errorRate: number;
    memoryUsage: MemoryUsage[];
}

interface MemoryUsage {
    timestamp: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
}

interface PerformanceBaseline {
    endpoint: string;
    averageResponseTime: number;
    throughput: number;
    timestamp: number;
}

class LoadTestRunner {
    private memoryBaseline: MemoryUsage | null = null;
    private performanceBaselines: Map<string, PerformanceBaseline> = new Map();
    
    /**
     * Simulate concurrent API requests to test load handling
     */
    async simulateLoad(
        endpoint: string,
        requestGenerator: () => Promise<any>,
        concurrentUsers: number = LOAD_TEST_CONFIG.CONCURRENT_USERS,
        requestsPerUser: number = LOAD_TEST_CONFIG.REQUESTS_PER_USER
    ): Promise<LoadTestResult> {
        const results: Array<{ success: boolean; responseTime: number; error?: any }> = [];
        const memoryUsage: MemoryUsage[] = [];
        
        // Start memory monitoring
        const memoryMonitor = this.startMemoryMonitoring(memoryUsage);
        
        const startTime = performance.now();
        
        // Create concurrent user simulation
        const userPromises = Array.from({ length: concurrentUsers }, async (_, userIndex) => {
            const userResults: Array<{ success: boolean; responseTime: number; error?: any }> = [];
            
            for (let i = 0; i < requestsPerUser; i++) {
                const requestStart = performance.now();
                try {
                    await requestGenerator();
                    const responseTime = performance.now() - requestStart;
                    userResults.push({ success: true, responseTime });
                } catch (error) {
                    const responseTime = performance.now() - requestStart;
                    userResults.push({ success: false, responseTime, error });
                }
                
                // Small delay between requests to simulate realistic usage
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            
            return userResults;
        });
        
        // Wait for all users to complete
        const allUserResults = await Promise.all(userPromises);
        const flatResults = allUserResults.flat();
        results.push(...flatResults);
        
        const endTime = performance.now();
        const totalDuration = endTime - startTime;
        
        // Stop memory monitoring
        clearInterval(memoryMonitor);
        
        // Calculate metrics
        const successfulRequests = results.filter(r => r.success).length;
        const failedRequests = results.filter(r => !r.success).length;
        const responseTimes = results.map(r => r.responseTime);
        
        return {
            totalRequests: results.length,
            successfulRequests,
            failedRequests,
            averageResponseTime: responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
            maxResponseTime: Math.max(...responseTimes),
            minResponseTime: Math.min(...responseTimes),
            throughput: (results.length / totalDuration) * 1000, // requests per second
            errorRate: failedRequests / results.length,
            memoryUsage,
        };
    }
    
    /**
     * Start monitoring memory usage during load testing
     */
    private startMemoryMonitoring(memoryUsage: MemoryUsage[]): NodeJS.Timeout {
        // Capture baseline memory usage
        if (!this.memoryBaseline) {
            const memInfo = process.memoryUsage();
            this.memoryBaseline = {
                timestamp: Date.now(),
                heapUsed: memInfo.heapUsed,
                heapTotal: memInfo.heapTotal,
                external: memInfo.external,
                rss: memInfo.rss,
            };
        }
        
        return setInterval(() => {
            const memInfo = process.memoryUsage();
            memoryUsage.push({
                timestamp: Date.now(),
                heapUsed: memInfo.heapUsed,
                heapTotal: memInfo.heapTotal,
                external: memInfo.external,
                rss: memInfo.rss,
            });
        }, LOAD_TEST_CONFIG.MEMORY_SAMPLE_INTERVAL);
    }
    
    /**
     * Detect memory leaks by analyzing memory usage patterns
     */
    detectMemoryLeaks(memoryUsage: MemoryUsage[]): {
        hasLeak: boolean;
        memoryGrowth: number;
        peakMemory: number;
        analysis: string;
    } {
        if (memoryUsage.length < 2 || !this.memoryBaseline) {
            return {
                hasLeak: false,
                memoryGrowth: 0,
                peakMemory: 0,
                analysis: "Insufficient data for leak detection",
            };
        }
        
        const baseline = this.memoryBaseline.heapUsed;
        const peak = Math.max(...memoryUsage.map(m => m.heapUsed));
        const final = memoryUsage[memoryUsage.length - 1].heapUsed;
        const memoryGrowth = final - baseline;
        
        // Check for sustained memory growth
        const hasLeak = memoryGrowth > LOAD_TEST_CONFIG.MAX_MEMORY_GROWTH;
        
        let analysis = `Memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB`;
        if (hasLeak) {
            analysis += ` (LEAK DETECTED - exceeds ${(LOAD_TEST_CONFIG.MAX_MEMORY_GROWTH / 1024 / 1024).toFixed(2)}MB threshold)`;
        }
        
        return {
            hasLeak,
            memoryGrowth,
            peakMemory: peak,
            analysis,
        };
    }
    
    /**
     * Detect performance regressions by comparing against baselines
     */
    detectPerformanceRegression(
        endpoint: string,
        currentResult: LoadTestResult
    ): {
        hasRegression: boolean;
        responseTimeRegression: number;
        throughputRegression: number;
        analysis: string;
    } {
        const baseline = this.performanceBaselines.get(endpoint);
        
        if (!baseline) {
            // Store current result as baseline
            this.performanceBaselines.set(endpoint, {
                endpoint,
                averageResponseTime: currentResult.averageResponseTime,
                throughput: currentResult.throughput,
                timestamp: Date.now(),
            });
            
            return {
                hasRegression: false,
                responseTimeRegression: 0,
                throughputRegression: 0,
                analysis: "Baseline established for future regression detection",
            };
        }
        
        const responseTimeRegression = currentResult.averageResponseTime / baseline.averageResponseTime;
        const throughputRegression = baseline.throughput / currentResult.throughput;
        
        const hasRegression = 
            responseTimeRegression > LOAD_TEST_CONFIG.REGRESSION_THRESHOLD ||
            throughputRegression > LOAD_TEST_CONFIG.REGRESSION_THRESHOLD;
        
        let analysis = `Response time: ${responseTimeRegression.toFixed(2)}x baseline, `;
        analysis += `Throughput: ${throughputRegression.toFixed(2)}x baseline`;
        
        if (hasRegression) {
            analysis += " (REGRESSION DETECTED)";
        }
        
        return {
            hasRegression,
            responseTimeRegression,
            throughputRegression,
            analysis,
        };
    }
    
    /**
     * Generate a comprehensive load test report
     */
    generateReport(
        endpoint: string,
        result: LoadTestResult,
        memoryAnalysis: ReturnType<LoadTestRunner['detectMemoryLeaks']>,
        regressionAnalysis: ReturnType<LoadTestRunner['detectPerformanceRegression']>
    ): string {
        return `
=== Load Test Report: ${endpoint} ===

📊 Performance Metrics:
  Total Requests: ${result.totalRequests}
  Successful: ${result.successfulRequests} (${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%)
  Failed: ${result.failedRequests} (${(result.errorRate * 100).toFixed(1)}%)
  
  Response Times:
    Average: ${result.averageResponseTime.toFixed(2)}ms
    Min: ${result.minResponseTime.toFixed(2)}ms
    Max: ${result.maxResponseTime.toFixed(2)}ms
  
  Throughput: ${result.throughput.toFixed(2)} req/sec

🧠 Memory Analysis:
  ${memoryAnalysis.analysis}
  Peak Memory: ${(memoryAnalysis.peakMemory / 1024 / 1024).toFixed(2)}MB

📈 Performance Regression:
  ${regressionAnalysis.analysis}

✅ Test Results:
  Response Time: ${result.averageResponseTime <= LOAD_TEST_CONFIG.MAX_RESPONSE_TIME ? 'PASS' : 'FAIL'}
  Error Rate: ${result.errorRate <= LOAD_TEST_CONFIG.MAX_ERROR_RATE ? 'PASS' : 'FAIL'}
  Throughput: ${result.throughput >= LOAD_TEST_CONFIG.MIN_THROUGHPUT ? 'PASS' : 'FAIL'}
  Memory Leaks: ${memoryAnalysis.hasLeak ? 'FAIL' : 'PASS'}
  Performance: ${regressionAnalysis.hasRegression ? 'FAIL' : 'PASS'}

=== End Report ===
        `.trim();
    }
}

describe("Load Testing Infrastructure", () => {
    let loadTestRunner: LoadTestRunner;
    
    beforeAll(async () => {
        await waitForDb();
        loadTestRunner = new LoadTestRunner();
        queryPerformanceMonitor.startMonitoring();
    });
    
    afterAll(async () => {
        queryPerformanceMonitor.stopMonitoring();
        await closeDb();
    });
    
    test("API endpoint load testing - Memory operations", async () => {
        await runWithWatchdog("memory operations load test", async () => {
            const result = await loadTestRunner.simulateLoad(
                "/api/memory",
                async () => {
                    // Simulate memory operations
                    const { q } = await import("../../src/core/db");
                    const userId = `load-test-${Date.now()}-${Math.random()}`;
                    
                    // Create a memory
                    await q.insMem.run(
                        `mem-${Date.now()}-${Math.random()}`,
                        userId,
                        0,
                        "Load test memory content",
                        null,
                        "test-sector",
                        null,
                        null,
                        Date.now(),
                        Date.now(),
                        Date.now(),
                        0.5,
                        0.1,
                        1
                    );
                    
                    // Query memories
                    await q.allMemByUser.all(userId, 10, 0);
                },
                5, // Reduced concurrent users for test stability
                10  // Reduced requests per user
            );
            
            // Analyze results
            const memoryAnalysis = loadTestRunner.detectMemoryLeaks(result.memoryUsage);
            const regressionAnalysis = loadTestRunner.detectPerformanceRegression("/api/memory", result);
            
            // Generate report
            const report = loadTestRunner.generateReport("/api/memory", result, memoryAnalysis, regressionAnalysis);
            console.log(report);
            
            // Assertions
            expect(result.errorRate).toBeLessThanOrEqual(LOAD_TEST_CONFIG.MAX_ERROR_RATE);
            expect(result.averageResponseTime).toBeLessThanOrEqual(LOAD_TEST_CONFIG.MAX_RESPONSE_TIME);
            expect(memoryAnalysis.hasLeak).toBe(false);
            
            return true;
        }, 30000);
    });
    
    test("API endpoint load testing - Database queries", async () => {
        await runWithWatchdog("database queries load test", async () => {
            const result = await loadTestRunner.simulateLoad(
                "/api/query",
                async () => {
                    // Simulate database query operations
                    const { q } = await import("../../src/core/db");
                    const userId = `query-test-${Date.now()}-${Math.random()}`;
                    
                    // Various query operations
                    await q.getMemCount.get(userId);
                    await q.getSectorStats.all(userId);
                    await q.getRecentActivity.all(5, userId);
                },
                5, // Reduced concurrent users
                15  // Moderate requests per user
            );
            
            // Analyze results
            const memoryAnalysis = loadTestRunner.detectMemoryLeaks(result.memoryUsage);
            const regressionAnalysis = loadTestRunner.detectPerformanceRegression("/api/query", result);
            
            // Generate report
            const report = loadTestRunner.generateReport("/api/query", result, memoryAnalysis, regressionAnalysis);
            console.log(report);
            
            // Assertions
            expect(result.errorRate).toBeLessThanOrEqual(LOAD_TEST_CONFIG.MAX_ERROR_RATE);
            expect(result.averageResponseTime).toBeLessThanOrEqual(LOAD_TEST_CONFIG.MAX_RESPONSE_TIME);
            expect(memoryAnalysis.hasLeak).toBe(false);
            
            return true;
        }, 30000);
    });
    
    test("Memory leak detection during sustained load", async () => {
        await runWithWatchdog("memory leak detection test", async () => {
            // Run a longer test to detect memory leaks
            const result = await loadTestRunner.simulateLoad(
                "/api/memory-intensive",
                async () => {
                    // Simulate memory-intensive operations
                    const { q } = await import("../../src/core/db");
                    const userId = `leak-test-${Date.now()}-${Math.random()}`;
                    
                    // Create multiple memories
                    for (let i = 0; i < 5; i++) {
                        await q.insMem.run(
                            `leak-mem-${Date.now()}-${i}-${Math.random()}`,
                            userId,
                            0,
                            `Memory leak test content ${i}`,
                            null,
                            "leak-test-sector",
                            null,
                            null,
                            Date.now(),
                            Date.now(),
                            Date.now(),
                            0.5,
                            0.1,
                            1
                        );
                    }
                    
                    // Query and process results
                    const memories = await q.allMemByUser.all(userId, 50, 0);
                    
                    // Simulate processing
                    memories.forEach(mem => {
                        // Simulate some processing that might cause leaks
                        const processed = JSON.stringify(mem);
                        JSON.parse(processed);
                    });
                },
                3, // Fewer concurrent users for intensive test
                20  // More requests per user
            );
            
            // Analyze for memory leaks
            const memoryAnalysis = loadTestRunner.detectMemoryLeaks(result.memoryUsage);
            
            console.log(`Memory Leak Analysis: ${memoryAnalysis.analysis}`);
            
            // Should not have memory leaks
            expect(memoryAnalysis.hasLeak).toBe(false);
            expect(memoryAnalysis.memoryGrowth).toBeLessThanOrEqual(LOAD_TEST_CONFIG.MAX_MEMORY_GROWTH);
            
            return true;
        }, 45000);
    });
    
    test("Performance regression detection", async () => {
        await runWithWatchdog("performance regression test", async () => {
            // Run baseline test
            const baselineResult = await loadTestRunner.simulateLoad(
                "/api/baseline",
                async () => {
                    const { q } = await import("../../src/core/db");
                    const userId = `baseline-${Date.now()}-${Math.random()}`;
                    await q.getMemCount.get(userId);
                },
                3,
                10
            );
            
            // Analyze baseline
            const baselineRegression = loadTestRunner.detectPerformanceRegression("/api/baseline", baselineResult);
            expect(baselineRegression.hasRegression).toBe(false); // Should establish baseline
            
            // Run comparison test (simulate slight performance degradation)
            const comparisonResult = await loadTestRunner.simulateLoad(
                "/api/baseline",
                async () => {
                    const { q } = await import("../../src/core/db");
                    const userId = `comparison-${Date.now()}-${Math.random()}`;
                    
                    // Add small delay to simulate performance degradation
                    await new Promise(resolve => setTimeout(resolve, 5));
                    await q.getMemCount.get(userId);
                },
                3,
                10
            );
            
            // Analyze for regression
            const regressionAnalysis = loadTestRunner.detectPerformanceRegression("/api/baseline", comparisonResult);
            
            console.log(`Regression Analysis: ${regressionAnalysis.analysis}`);
            
            // Verify regression detection works
            expect(regressionAnalysis.responseTimeRegression).toBeGreaterThan(1);
            
            return true;
        }, 30000);
    });
    
    test("Concurrent user simulation with realistic patterns", async () => {
        await runWithWatchdog("concurrent user simulation test", async () => {
            // Simulate realistic user behavior patterns
            const userPatterns = [
                // Pattern 1: Heavy reader
                async () => {
                    const { q } = await import("../../src/core/db");
                    const userId = `reader-${Date.now()}-${Math.random()}`;
                    await q.allMemByUser.all(userId, 20, 0);
                    await q.getSectorStats.all(userId);
                    await q.getRecentActivity.all(10, userId);
                },
                // Pattern 2: Heavy writer
                async () => {
                    const { q } = await import("../../src/core/db");
                    const userId = `writer-${Date.now()}-${Math.random()}`;
                    for (let i = 0; i < 3; i++) {
                        await q.insMem.run(
                            `pattern-mem-${Date.now()}-${i}-${Math.random()}`,
                            userId,
                            0,
                            `Pattern test content ${i}`,
                            null,
                            "pattern-sector",
                            null,
                            null,
                            Date.now(),
                            Date.now(),
                            Date.now(),
                            0.5,
                            0.1,
                            1
                        );
                    }
                },
                // Pattern 3: Mixed operations
                async () => {
                    const { q } = await import("../../src/core/db");
                    const userId = `mixed-${Date.now()}-${Math.random()}`;
                    await q.getMemCount.get(userId);
                    await q.insMem.run(
                        `mixed-mem-${Date.now()}-${Math.random()}`,
                        userId,
                        0,
                        "Mixed pattern content",
                        null,
                        "mixed-sector",
                        null,
                        null,
                        Date.now(),
                        Date.now(),
                        Date.now(),
                        0.5,
                        0.1,
                        1
                    );
                    await q.allMemByUser.all(userId, 5, 0);
                }
            ];
            
            // Run concurrent tests with different patterns
            const results = await Promise.all(
                userPatterns.map(async (pattern, index) => {
                    return await loadTestRunner.simulateLoad(
                        `/api/pattern-${index}`,
                        pattern,
                        2, // 2 concurrent users per pattern
                        8   // 8 requests per user
                    );
                })
            );
            
            // Analyze all results
            results.forEach((result, index) => {
                const memoryAnalysis = loadTestRunner.detectMemoryLeaks(result.memoryUsage);
                const regressionAnalysis = loadTestRunner.detectPerformanceRegression(`/api/pattern-${index}`, result);
                
                console.log(`Pattern ${index} Results:`);
                console.log(`  Throughput: ${result.throughput.toFixed(2)} req/sec`);
                console.log(`  Error Rate: ${(result.errorRate * 100).toFixed(1)}%`);
                console.log(`  Memory: ${memoryAnalysis.analysis}`);
                
                // Assertions for each pattern
                expect(result.errorRate).toBeLessThanOrEqual(LOAD_TEST_CONFIG.MAX_ERROR_RATE);
                expect(memoryAnalysis.hasLeak).toBe(false);
            });
            
            return true;
        }, 45000);
    });
});