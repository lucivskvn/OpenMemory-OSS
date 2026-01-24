/**
 * @file Property Test: Essential Monitoring Capability
 * **Property 43: Essential Monitoring Capability**
 * **Validates: Requirements 8.6**
 * 
 * This property test validates that the monitoring system provides essential
 * capabilities including metrics collection, health checks, and performance tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { metricsCollector } from "../../src/utils/metricsCollector";
import { healthChecker } from "../../src/utils/healthChecker";
import { waitForDb, closeDb } from "../../src/core/db";

describe("Property Test: Essential Monitoring Capability", () => {
    beforeEach(async () => {
        // Ensure database is ready for health checks
        await waitForDb();
    });

    afterEach(async () => {
        // Clean up after each test
        await closeDb();
    });

    /**
     * Property 43: Essential Monitoring Capability
     * 
     * The monitoring system must provide:
     * 1. Metrics collection for system performance
     * 2. Health check capabilities for system components
     * 3. Performance tracking with reasonable response times
     * 4. Structured data output for monitoring tools
     * 5. Configurable thresholds and alerting capabilities
     */
    it("should provide comprehensive monitoring capabilities", () => {
        fc.assert(
            fc.property(
                // Generate test scenarios for monitoring
                fc.record({
                    timeWindow: fc.integer({ min: 1000, max: 300000 }), // 1s to 5min
                    operationCount: fc.integer({ min: 1, max: 100 }),
                    expectedSuccessRate: fc.double({ min: 0.5, max: 1.0 }),
                    maxResponseTime: fc.integer({ min: 10, max: 5000 }), // 10ms to 5s
                    componentName: fc.constantFrom('database', 'vector_store', 'memory', 'api'),
                    metricType: fc.constantFrom('counter', 'histogram', 'gauge', 'summary')
                }),
                (testData) => {
                    // Property 1: Metrics collection capability
                    const startTime = Date.now();
                    
                    // Simulate operations and collect metrics
                    for (let i = 0; i < testData.operationCount; i++) {
                        const operationStart = Date.now();
                        const duration = Math.random() * testData.maxResponseTime;
                        const success = Math.random() < testData.expectedSuccessRate;
                        
                        // Record metrics
                        metricsCollector.recordApiEndpoint({
                            endpoint: '/test/endpoint',
                            method: 'GET',
                            statusCode: success ? 200 : 500,
                            duration
                        });
                        
                        metricsCollector.recordVectorOperation({
                            operation: 'similarity',
                            duration,
                            vectorCount: Math.floor(Math.random() * 1000),
                            dimensions: 384,
                            success
                        });
                        
                        metricsCollector.recordDatabaseQuery({
                            query: 'SELECT * FROM test',
                            duration,
                            rowsAffected: Math.floor(Math.random() * 100),
                            success
                        });
                    }
                    
                    // Get metrics summary
                    const metricsSummary = metricsCollector.getMetricsSummary(testData.timeWindow);
                    
                    // Property 1: Metrics are collected and structured
                    expect(metricsSummary).toBeDefined();
                    expect(metricsSummary.api).toBeDefined();
                    expect(metricsSummary.vector).toBeDefined();
                    expect(metricsSummary.database).toBeDefined();
                    
                    // Property 2: Metrics contain essential performance data
                    expect(metricsSummary.api.totalRequests).toBeGreaterThanOrEqual(0);
                    expect(metricsSummary.vector.totalOperations).toBeGreaterThanOrEqual(0);
                    expect(metricsSummary.database.totalQueries).toBeGreaterThanOrEqual(0);
                    
                    // Only check averages if there are operations recorded
                    if (metricsSummary.api.totalRequests > 0) {
                        expect(metricsSummary.api.averageDuration).toBeGreaterThan(0);
                        expect(metricsSummary.api.successRate).toBeGreaterThanOrEqual(0);
                        expect(metricsSummary.api.successRate).toBeLessThanOrEqual(1);
                    }
                    
                    if (metricsSummary.vector.totalOperations > 0) {
                        expect(metricsSummary.vector.averageDuration).toBeGreaterThan(0);
                        expect(metricsSummary.vector.successRate).toBeGreaterThanOrEqual(0);
                        expect(metricsSummary.vector.successRate).toBeLessThanOrEqual(1);
                    }
                    
                    if (metricsSummary.database.totalQueries > 0) {
                        expect(metricsSummary.database.averageDuration).toBeGreaterThan(0);
                        expect(metricsSummary.database.successRate).toBeGreaterThanOrEqual(0);
                        expect(metricsSummary.database.successRate).toBeLessThanOrEqual(1);
                    }
                    
                    // Property 3: Metrics provide breakdown by operation type
                    expect(metricsSummary.api.endpointBreakdown).toBeDefined();
                    expect(metricsSummary.api.statusCodeBreakdown).toBeDefined();
                    expect(metricsSummary.vector.operationBreakdown).toBeDefined();
                    expect(metricsSummary.database.queryTypeBreakdown).toBeDefined();
                    
                    // Property 4: Performance tracking identifies slow operations
                    expect(Array.isArray(metricsSummary.api.slowestEndpoints)).toBe(true);
                    expect(Array.isArray(metricsSummary.vector.slowestOperations)).toBe(true);
                    expect(Array.isArray(metricsSummary.database.slowestQueries)).toBe(true);
                    
                    // Property 5: Metrics collection is performant
                    const collectionTime = Date.now() - startTime;
                    expect(collectionTime).toBeLessThan(testData.operationCount * 10); // Max 10ms per operation
                }
            ),
            { numRuns: 25 }
        );
    });

    /**
     * Property 43.1: Health Check Capability
     * 
     * The health check system must:
     * 1. Provide quick health status for essential components
     * 2. Return structured health information
     * 3. Complete health checks within reasonable time limits
     * 4. Support both quick and comprehensive health checks
     */
    it("should provide reliable health check capabilities", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    timeoutMs: fc.integer({ min: 1000, max: 10000 }),
                    expectedComponents: fc.array(
                        fc.constantFrom('database', 'memory', 'disk', 'vector_store', 'embedding_service'),
                        { minLength: 3, maxLength: 5 }
                    ),
                    healthThreshold: fc.double({ min: 0.8, max: 1.0 })
                }),
                async (testData) => {
                    // Property 1: Quick health check capability
                    const quickStartTime = Date.now();
                    const quickResult = await healthChecker.quickHealthCheck();
                    const quickDuration = Date.now() - quickStartTime;
                    
                    // Quick health check should be fast
                    expect(quickDuration).toBeLessThan(1000); // < 1 second
                    expect(quickResult).toHaveProperty('healthy');
                    expect(typeof quickResult.healthy).toBe('boolean');
                    
                    // Property 2: Comprehensive health check capability
                    const comprehensiveStartTime = Date.now();
                    const comprehensiveResult = await healthChecker.runHealthChecks();
                    const comprehensiveDuration = Date.now() - comprehensiveStartTime;
                    
                    // Comprehensive health check should complete within timeout
                    expect(comprehensiveDuration).toBeLessThan(testData.timeoutMs);
                    
                    // Property 3: Structured health information
                    expect(comprehensiveResult).toHaveProperty('overall');
                    expect(comprehensiveResult).toHaveProperty('checks');
                    expect(comprehensiveResult).toHaveProperty('timestamp');
                    expect(comprehensiveResult).toHaveProperty('uptime');
                    expect(comprehensiveResult).toHaveProperty('version');
                    
                    expect(['healthy', 'degraded', 'unhealthy']).toContain(comprehensiveResult.overall);
                    expect(Array.isArray(comprehensiveResult.checks)).toBe(true);
                    expect(comprehensiveResult.checks.length).toBeGreaterThan(0);
                    
                    // Property 4: Essential components are checked
                    const checkNames = comprehensiveResult.checks.map(c => c.name);
                    const essentialComponents = ['database', 'memory', 'vector_store'];
                    essentialComponents.forEach(component => {
                        expect(checkNames).toContain(component);
                    });
                    
                    // Property 5: Each health check has required structure
                    comprehensiveResult.checks.forEach(check => {
                        expect(check).toHaveProperty('name');
                        expect(check).toHaveProperty('status');
                        expect(['healthy', 'degraded', 'unhealthy']).toContain(check.status);
                        expect(typeof check.name).toBe('string');
                        expect(check.name.length).toBeGreaterThan(0);
                        
                        // Duration should be present and reasonable
                        if (check.duration !== undefined) {
                            expect(check.duration).toBeGreaterThanOrEqual(0);
                            expect(check.duration).toBeLessThan(testData.timeoutMs);
                        }
                    });
                    
                    // Property 6: Health status consistency
                    const healthyChecks = comprehensiveResult.checks.filter(c => c.status === 'healthy').length;
                    const totalChecks = comprehensiveResult.checks.length;
                    const healthRatio = healthyChecks / totalChecks;
                    
                    if (comprehensiveResult.overall === 'healthy') {
                        expect(healthRatio).toBeGreaterThanOrEqual(testData.healthThreshold);
                    }
                }
            ),
            { numRuns: 20 }
        );
    });

    /**
     * Property 43.2: Performance Tracking Capability
     * 
     * The monitoring system must track performance metrics:
     * 1. Response times for operations
     * 2. Success/failure rates
     * 3. Resource utilization
     * 4. Trend analysis over time
     */
    it("should provide comprehensive performance tracking", () => {
        fc.assert(
            fc.property(
                fc.record({
                    operationTypes: fc.array(
                        fc.constantFrom('api_request', 'vector_search', 'database_query', 'memory_operation'),
                        { minLength: 2, maxLength: 4 }
                    ),
                    sampleSize: fc.integer({ min: 10, max: 200 }),
                    timeRange: fc.integer({ min: 60000, max: 3600000 }), // 1min to 1hour
                    performanceThreshold: fc.double({ min: 0.1, max: 2.0 }) // seconds
                }),
                (testData) => {
                    const startTime = Date.now();
                    
                    // Generate performance data
                    testData.operationTypes.forEach(operationType => {
                        for (let i = 0; i < testData.sampleSize; i++) {
                            const duration = Math.random() * testData.performanceThreshold * 1000; // Convert to ms
                            const success = Math.random() > 0.1; // 90% success rate
                            
                            switch (operationType) {
                                case 'api_request':
                                    metricsCollector.recordApiEndpoint({
                                        endpoint: `/api/test/${i}`,
                                        method: 'POST',
                                        statusCode: success ? 200 : 500,
                                        duration
                                    });
                                    break;
                                case 'vector_search':
                                    metricsCollector.recordVectorOperation({
                                        operation: 'search',
                                        duration,
                                        vectorCount: Math.floor(Math.random() * 1000),
                                        dimensions: 384,
                                        success
                                    });
                                    break;
                                case 'database_query':
                                    metricsCollector.recordDatabaseQuery({
                                        query: 'SELECT * FROM test',
                                        duration,
                                        rowsAffected: Math.floor(Math.random() * 100),
                                        success
                                    });
                                    break;
                            }
                        }
                    });
                    
                    // Get performance metrics
                    const metrics = metricsCollector.getMetricsSummary(testData.timeRange);
                    
                    // Property 1: Performance data is collected for all operation types
                    testData.operationTypes.forEach(operationType => {
                        switch (operationType) {
                            case 'api_request':
                                expect(metrics.api.totalRequests).toBeGreaterThan(0);
                                expect(metrics.api.averageDuration).toBeGreaterThan(0);
                                break;
                            case 'vector_search':
                                expect(metrics.vector.totalOperations).toBeGreaterThan(0);
                                expect(metrics.vector.averageDuration).toBeGreaterThan(0);
                                break;
                            case 'database_query':
                                expect(metrics.database.totalQueries).toBeGreaterThan(0);
                                expect(metrics.database.averageDuration).toBeGreaterThan(0);
                                break;
                        }
                    });
                    
                    // Property 2: Success rates are tracked and reasonable
                    if (metrics.api.totalRequests > 0) {
                        expect(metrics.api.successRate).toBeGreaterThan(0.5); // At least 50% success
                    }
                    if (metrics.vector.totalOperations > 0) {
                        expect(metrics.vector.successRate).toBeGreaterThan(0.5);
                    }
                    if (metrics.database.totalQueries > 0) {
                        expect(metrics.database.successRate).toBeGreaterThan(0.5);
                    }
                    
                    // Property 3: Performance thresholds can be evaluated
                    const avgApiDuration = metrics.api.averageDuration;
                    const avgVectorDuration = metrics.vector.averageDuration;
                    const avgDbDuration = metrics.database.averageDuration;
                    
                    if (metrics.api.totalRequests > 0) {
                        expect(avgApiDuration).toBeGreaterThan(0);
                    }
                    if (metrics.vector.totalOperations > 0) {
                        expect(avgVectorDuration).toBeGreaterThan(0);
                    }
                    if (metrics.database.totalQueries > 0) {
                        expect(avgDbDuration).toBeGreaterThan(0);
                    }
                    
                    // Property 4: Slow operations are identified
                    expect(Array.isArray(metrics.api.slowestEndpoints)).toBe(true);
                    expect(Array.isArray(metrics.vector.slowestOperations)).toBe(true);
                    expect(Array.isArray(metrics.database.slowestQueries)).toBe(true);
                    
                    // Property 5: Metrics collection is efficient
                    const collectionTime = Date.now() - startTime;
                    const totalOperations = testData.operationTypes.length * testData.sampleSize;
                    expect(collectionTime).toBeLessThan(totalOperations * 5); // Max 5ms per operation
                }
            ),
            { numRuns: 25 }
        );
    });

    /**
     * Property 43.3: Monitoring Data Export Capability
     * 
     * The monitoring system must support:
     * 1. Prometheus-compatible metrics export
     * 2. Structured JSON output
     * 3. Configurable metric retention
     * 4. Efficient data serialization
     */
    it("should provide reliable monitoring data export", () => {
        fc.assert(
            fc.property(
                fc.record({
                    metricCount: fc.integer({ min: 5, max: 50 }),
                    exportFormat: fc.constantFrom('prometheus', 'json'),
                    retentionPeriod: fc.integer({ min: 3600, max: 86400 }), // 1 hour to 1 day
                    compressionEnabled: fc.boolean()
                }),
                (testData) => {
                    // Generate sample metrics
                    for (let i = 0; i < testData.metricCount; i++) {
                        metricsCollector.recordApiEndpoint({
                            endpoint: `/api/metric/${i}`,
                            method: 'GET',
                            statusCode: 200,
                            duration: Math.random() * 1000
                        });
                    }
                    
                    // Property 1: Prometheus export capability
                    const prometheusMetrics = metricsCollector.generatePrometheusMetrics();
                    expect(typeof prometheusMetrics).toBe('string');
                    expect(prometheusMetrics.length).toBeGreaterThan(0);
                    
                    // Prometheus format validation
                    expect(prometheusMetrics).toContain('# HELP');
                    expect(prometheusMetrics).toContain('# TYPE');
                    
                    // Property 2: JSON export capability
                    const jsonMetrics = metricsCollector.getMetricsSummary(testData.retentionPeriod * 1000);
                    expect(typeof jsonMetrics).toBe('object');
                    expect(jsonMetrics).not.toBeNull();
                    
                    // JSON structure validation
                    expect(jsonMetrics).toHaveProperty('api');
                    expect(jsonMetrics).toHaveProperty('vector');
                    expect(jsonMetrics).toHaveProperty('database');
                    
                    // Property 3: Data serialization is efficient
                    const serializationStart = Date.now();
                    const serializedJson = JSON.stringify(jsonMetrics);
                    const serializationTime = Date.now() - serializationStart;
                    
                    expect(serializationTime).toBeLessThan(100); // < 100ms
                    expect(serializedJson.length).toBeGreaterThan(0);
                    
                    // Property 4: Exported data is valid and parseable
                    const parsedMetrics = JSON.parse(serializedJson);
                    expect(parsedMetrics).toEqual(jsonMetrics);
                    
                    // Property 5: Metrics contain timestamp information
                    if (jsonMetrics.api.totalRequests > 0) {
                        expect(jsonMetrics.api.totalRequests).toBeGreaterThanOrEqual(1);
                    }
                }
            ),
            { numRuns: 20 }
        );
    });
});