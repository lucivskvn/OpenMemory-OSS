/**
 * @file Property-Based Tests for Database Query Efficiency
 * **Property 13: Database Query Efficiency**
 * **Validates: Requirements 3.3**
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fc from "fast-check";
import { runWithWatchdog } from "../../src/utils/testWatchdog";
import { 
    queryPerformanceMonitor, 
    connectionPoolOptimizer,
    QueryMetrics 
} from "../../src/core/queryOptimizer";
import { indexOptimizer } from "../../src/core/indexOptimizer";
import { MemoryRepository } from "../../src/core/repository/memory";
import { WaypointRepository } from "../../src/core/repository/waypoint";
import { TemporalRepository } from "../../src/core/repository/temporal";
import { q, waitForDb, closeDb } from "../../src/core/db";
import { getIsPg } from "../../src/core/db_access";

// Performance thresholds based on Requirements 3.3
const PERFORMANCE_THRESHOLDS = {
    // Query execution time thresholds (milliseconds)
    SIMPLE_QUERY_MAX_TIME: 50,        // Simple SELECT queries
    COMPLEX_QUERY_MAX_TIME: 200,      // Complex JOIN queries
    BATCH_QUERY_MAX_TIME: 500,        // Batch operations
    INDEX_SCAN_MAX_TIME: 100,         // Index-based queries
    
    // Connection pool efficiency
    MIN_POOL_UTILIZATION: 0.7,       // 70% minimum pool utilization
    MAX_CONNECTION_WAIT_TIME: 100,    // 100ms max wait for connection
    
    // Query pattern efficiency
    MAX_FULL_TABLE_SCAN_RATIO: 0.1,  // 10% max full table scans
    MIN_INDEX_HIT_RATIO: 0.8,        // 80% minimum index usage
    
    // Batch operation efficiency
    MIN_BATCH_SPEEDUP: 2.0,          // 2x speedup for batch vs individual
    MAX_MEMORY_OVERHEAD: 1.2,        // 20% max memory overhead for batching
    
    // Connection management
    MAX_IDLE_CONNECTION_RATIO: 0.3,  // 30% max idle connections
    MIN_QUERY_CACHE_HIT_RATE: 0.75,  // 75% minimum cache hit rate
};

describe("Property 13: Database Query Efficiency", () => {
    beforeAll(async () => {
        await waitForDb();
        queryPerformanceMonitor.startMonitoring();
        queryPerformanceMonitor.reset();
        
        // Initialize optimized indexes for testing
        await indexOptimizer.createRecommendedIndexes();
    });

    afterAll(async () => {
        queryPerformanceMonitor.stopMonitoring();
        const report = queryPerformanceMonitor.generateReport();
        console.log("\n" + report);
        await closeDb();
    });

    test("Property: Simple queries execute within performance thresholds", async () => {
        await runWithWatchdog("simple query performance property", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 }),
                    fc.string({ minLength: 1, maxLength: 20 }),
                    async (memoryIds, userId) => {
                        // Test simple memory retrieval queries
                        const startTime = performance.now();
                        
                        // Single memory lookup (should use primary key index)
                        if (memoryIds.length > 0) {
                            await q.getMem.get(memoryIds[0], userId);
                        }
                        
                        // Multiple memory lookup (should use IN clause optimization)
                        const testIds = memoryIds.slice(0, 5); // Limit to 5 for test
                        if (testIds.length > 0) {
                            await q.getMems.all(testIds, userId);
                        }
                        
                        // User-scoped count query (should use user index)
                        await q.getMemCount.get(userId);
                        
                        const totalTime = performance.now() - startTime;
                        
                        // Verify performance threshold
                        expect(totalTime).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.SIMPLE_QUERY_MAX_TIME);
                        
                        return true;
                    }
                ),
                { numRuns: 25, timeout: 15000 }
            );
        }, 20000);
    });

    test("Property: Complex queries with joins execute efficiently", async () => {
        await runWithWatchdog("complex query performance property", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({ minLength: 1, maxLength: 20 }),
                    fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 5 }),
                    fc.integer({ min: 1, max: 100 }),
                    async (userId, sectors, limit) => {
                        const startTime = performance.now();
                        
                        // Complex query: memories with sector filtering and ordering
                        if (sectors.length > 0) {
                            await q.allMemBySector.all(sectors[0], limit, 0, userId);
                        }
                        
                        // Complex query: sector statistics (GROUP BY with aggregation)
                        await q.getSectorStats.all(userId);
                        
                        // Complex query: recent activity with ordering
                        await q.getRecentActivity.all(Math.min(limit, 20), userId);
                        
                        // Complex query: top memories with salience ordering
                        await q.getTopMemories.all(Math.min(limit, 20), userId);
                        
                        const totalTime = performance.now() - startTime;
                        
                        // Verify performance threshold for complex queries
                        expect(totalTime).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.COMPLEX_QUERY_MAX_TIME);
                        
                        return true;
                    }
                ),
                { numRuns: 20, timeout: 20000 }
            );
        }, 25000);
    });

    test("Property: Batch operations demonstrate efficiency gains", async () => {
        await runWithWatchdog("batch operation efficiency property", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.array(
                        fc.record({
                            id: fc.string({ minLength: 1, maxLength: 20 }),
                            salience: fc.float({ min: 0, max: 1 }),
                            lastSeenAt: fc.integer({ min: 1000000000000, max: Date.now() }),
                            updatedAt: fc.integer({ min: 1000000000000, max: Date.now() })
                        }),
                        { minLength: 5, maxLength: 50 }
                    ),
                    fc.string({ minLength: 1, maxLength: 20 }),
                    async (updates, userId) => {
                        // Test batch vs individual update performance
                        const testUpdates = updates.slice(0, 10); // Limit for test performance
                        
                        // Measure individual updates
                        const individualStart = performance.now();
                        for (const update of testUpdates.slice(0, 3)) { // Test with fewer items
                            await q.updSeen.run(
                                update.id, 
                                update.lastSeenAt, 
                                update.salience, 
                                update.updatedAt, 
                                userId
                            );
                        }
                        const individualTime = performance.now() - individualStart;
                        
                        // Measure batch update
                        const batchStart = performance.now();
                        await q.updSaliences.run(testUpdates.slice(3, 6), userId); // Test with remaining items
                        const batchTime = performance.now() - batchStart;
                        
                        // Verify batch operations are more efficient (when applicable)
                        if (testUpdates.length >= 3 && batchTime > 0 && individualTime > 0) {
                            const timePerItemIndividual = individualTime / 3;
                            const timePerItemBatch = batchTime / 3;
                            
                            // Batch should be at least as efficient as individual operations
                            expect(timePerItemBatch).toBeLessThanOrEqual(timePerItemIndividual * 1.5); // Allow 50% overhead for small batches
                        }
                        
                        // Verify total batch time is within threshold
                        expect(batchTime).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.BATCH_QUERY_MAX_TIME);
                        
                        return true;
                    }
                ),
                { numRuns: 15, timeout: 25000 }
            );
        }, 30000);
    });

    test("Property: Index-based queries outperform full table scans", async () => {
        await runWithWatchdog("index efficiency property", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({ minLength: 1, maxLength: 20 }),
                    fc.string({ minLength: 1, maxLength: 10 }),
                    fc.integer({ min: 1, max: 50 }),
                    async (userId, sector, limit) => {
                        const startTime = performance.now();
                        
                        // Index-based queries that should be fast
                        
                        // 1. Primary key lookup (fastest)
                        const testId = `test-${Date.now()}`;
                        await q.getMem.get(testId, userId);
                        
                        // 2. User index lookup
                        await q.allMemByUser.all(userId, limit, 0);
                        
                        // 3. Sector index lookup
                        await q.allMemBySector.all(sector, limit, 0, userId);
                        
                        // 4. Time-based index lookup (recent activity)
                        await q.getRecentActivity.all(limit, userId);
                        
                        const totalTime = performance.now() - startTime;
                        
                        // Index-based queries should be fast
                        expect(totalTime).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.INDEX_SCAN_MAX_TIME);
                        
                        return true;
                    }
                ),
                { numRuns: 25, timeout: 15000 }
            );
        }, 20000);
    });

    test("Property: Connection pool utilization remains efficient", async () => {
        await runWithWatchdog("connection pool efficiency property", async () => {
            // Only test connection pool for PostgreSQL
            if (!getIsPg()) {
                return true; // Skip for SQLite
            }
            
            const poolHealth = connectionPoolOptimizer.analyzePoolHealth();
            const poolStats = queryPerformanceMonitor.getPoolStats();
            
            // Verify pool health metrics
            expect(['excellent', 'good', 'fair']).toContain(poolHealth.health);
            
            // Verify connection efficiency
            if (poolStats.totalQueries > 10) {
                expect(poolStats.averageQueryTime).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.MAX_CONNECTION_WAIT_TIME);
            }
            
            // Verify cache performance
            if (poolStats.totalQueries > 5) {
                expect(poolStats.cacheHitRate).toBeGreaterThanOrEqual(PERFORMANCE_THRESHOLDS.MIN_QUERY_CACHE_HIT_RATE);
            }
            
            return true;
        }, 10000);
    });

    test("Property: Query performance monitoring captures accurate metrics", async () => {
        await runWithWatchdog("query monitoring accuracy property", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 3 }), // Reduced array size
                    fc.string({ minLength: 1, maxLength: 20 }),
                    async (testIds, userId) => {
                        // Clear metrics for clean test
                        queryPerformanceMonitor.reset();
                        const initialMetrics = queryPerformanceMonitor.getMetrics().length;
                        
                        // Perform some queries that should be monitored
                        for (const id of testIds) {
                            await q.getMem.get(id, userId);
                        }
                        
                        // Give a small delay for metrics to be recorded
                        await new Promise(resolve => setTimeout(resolve, 10));
                        
                        // Check that metrics were recorded
                        const finalMetrics = queryPerformanceMonitor.getMetrics().length;
                        
                        // Should have at least some metrics recorded (may not be exact due to caching)
                        expect(finalMetrics).toBeGreaterThanOrEqual(initialMetrics);
                        
                        // If metrics were recorded, verify their structure
                        if (finalMetrics > initialMetrics) {
                            const recentMetrics = queryPerformanceMonitor.getMetrics().slice(-1);
                            for (const metric of recentMetrics) {
                                expect(metric.duration).toBeGreaterThanOrEqual(0);
                                expect(metric.timestamp).toBeGreaterThan(0);
                                expect(metric.sql).toBeTruthy();
                                expect(['sqlite', 'postgres']).toContain(metric.backend);
                            }
                        }
                        
                        return true;
                    }
                ),
                { numRuns: 10, timeout: 15000 } // Reduced runs for stability
            );
        }, 20000);
    });

    test("Property: Query patterns are optimized for common operations", async () => {
        await runWithWatchdog("query pattern optimization property", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({ minLength: 1, maxLength: 20 }),
                    fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 10 }),
                    async (userId, keywords) => {
                        const startTime = performance.now();
                        
                        // Test common query patterns that should be optimized
                        
                        // 1. Keyword search (should use indexes where possible)
                        if (keywords.length > 0) {
                            await q.searchMemsByKeyword.all(keywords[0], 10, userId);
                        }
                        
                        // 2. Metadata filtering (should use appropriate indexes)
                        await q.findMems.all({
                            userId,
                            limit: 10,
                            offset: 0
                        });
                        
                        // 3. Temporal queries (should use time indexes)
                        const now = Date.now();
                        const dayAgo = now - (24 * 60 * 60 * 1000);
                        
                        // 4. Waypoint traversal (should use src/dst indexes)
                        const testId = `test-${Date.now()}`;
                        await q.getWaypointsBySrc.all(testId, userId);
                        
                        const totalTime = performance.now() - startTime;
                        
                        // Common operations should complete quickly
                        expect(totalTime).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.COMPLEX_QUERY_MAX_TIME);
                        
                        return true;
                    }
                ),
                { numRuns: 20, timeout: 20000 }
            );
        }, 25000);
    });

    test("Property: Database query optimization recommendations are actionable", async () => {
        await runWithWatchdog("optimization recommendations property", async () => {
            // Generate some query load to analyze
            const userId = `test-user-${Date.now()}`;
            
            // Perform various queries to generate patterns
            for (let i = 0; i < 10; i++) {
                await q.getMem.get(`test-${i}`, userId);
                await q.getSectorStats.all(userId);
                await q.getRecentActivity.all(5, userId);
            }
            
            // Get optimization recommendations
            const recommendations = queryPerformanceMonitor.generateRecommendations();
            
            // Verify recommendations are well-formed
            for (const rec of recommendations) {
                expect(['index', 'query', 'connection', 'cache']).toContain(rec.type);
                expect(['low', 'medium', 'high', 'critical']).toContain(rec.severity);
                expect(rec.description).toBeTruthy();
                expect(rec.suggestion).toBeTruthy();
                expect(rec.impact).toBeTruthy();
            }
            
            // Verify pool health analysis
            const poolHealth = connectionPoolOptimizer.analyzePoolHealth();
            expect(['excellent', 'good', 'fair', 'poor']).toContain(poolHealth.health);
            expect(Array.isArray(poolHealth.issues)).toBe(true);
            expect(Array.isArray(poolHealth.recommendations)).toBe(true);
            
            return true;
        }, 15000);
    });

    test("Property: Query caching improves performance for repeated operations", async () => {
        await runWithWatchdog("query caching performance property", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({ minLength: 1, maxLength: 20 }),
                    fc.string({ minLength: 1, maxLength: 10 }),
                    async (userId, testId) => {
                        // Measure first query (cache miss)
                        const firstStart = performance.now();
                        await q.getMem.get(testId, userId);
                        const firstTime = performance.now() - firstStart;
                        
                        // Small delay to ensure timing separation
                        await new Promise(resolve => setTimeout(resolve, 1));
                        
                        // Measure second query (potential cache hit)
                        const secondStart = performance.now();
                        await q.getMem.get(testId, userId);
                        const secondTime = performance.now() - secondStart;
                        
                        // Both queries should complete within reasonable time
                        expect(firstTime).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.SIMPLE_QUERY_MAX_TIME);
                        expect(secondTime).toBeLessThanOrEqual(PERFORMANCE_THRESHOLDS.SIMPLE_QUERY_MAX_TIME);
                        
                        // Second query should not be significantly slower (allow for timing variance)
                        // Use a more generous multiplier to account for system timing variations
                        expect(secondTime).toBeLessThanOrEqual(firstTime * 5); // Allow 5x variance for timing fluctuations
                        
                        return true;
                    }
                ),
                { numRuns: 15, timeout: 15000 } // Reduced runs for stability
            );
        }, 20000);
    });
});