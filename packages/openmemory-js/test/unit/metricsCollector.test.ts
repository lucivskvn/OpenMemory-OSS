/**
 * @file Metrics Collector Tests
 * Tests for the enhanced metrics collection system
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MetricsCollector } from "../../src/utils/metricsCollector";

describe("MetricsCollector", () => {
    let collector: MetricsCollector;

    beforeEach(() => {
        collector = new MetricsCollector();
    });

    afterEach(() => {
        collector.stop();
    });

    it("should record vector operation metrics", () => {
        collector.recordVectorOperation({
            operation: 'embedding',
            duration: 150,
            vectorCount: 10,
            dimensions: 384,
            success: true
        });

        const stats = collector.getVectorOperationStats();
        expect(stats.totalOperations).toBe(1);
        expect(stats.averageDuration).toBe(150);
        expect(stats.successRate).toBe(1);
        expect(stats.operationBreakdown.embedding).toBe(1);
    });

    it("should record database query metrics", () => {
        collector.recordDatabaseQuery({
            query: "SELECT * FROM memories WHERE user_id = ?",
            duration: 25,
            rowsAffected: 5,
            success: true
        });

        const stats = collector.getDatabaseQueryStats();
        expect(stats.totalQueries).toBe(1);
        expect(stats.averageDuration).toBe(25);
        expect(stats.successRate).toBe(1);
        expect(stats.queryTypeBreakdown.select).toBe(1);
    });

    it("should record API endpoint metrics", () => {
        collector.recordApiEndpoint({
            endpoint: "/api/memories",
            method: "GET",
            statusCode: 200,
            duration: 100
        });

        const stats = collector.getApiEndpointStats();
        expect(stats.totalRequests).toBe(1);
        expect(stats.averageDuration).toBe(100);
        expect(stats.successRate).toBe(1);
        expect(stats.statusCodeBreakdown[200]).toBe(1);
    });

    it("should generate Prometheus metrics format", () => {
        collector.recordVectorOperation({
            operation: 'similarity',
            duration: 75,
            vectorCount: 5,
            dimensions: 256,
            success: true
        });

        const prometheus = collector.generatePrometheusMetrics();
        expect(prometheus).toContain('openmemory_vector_operations_total');
        expect(prometheus).toContain('openmemory_vector_operation_duration_avg');
        expect(prometheus).toContain('openmemory_memory_usage_bytes');
    });

    it("should provide comprehensive metrics summary", () => {
        collector.recordVectorOperation({
            operation: 'search',
            duration: 200,
            vectorCount: 20,
            dimensions: 512,
            success: true
        });

        collector.recordDatabaseQuery({
            query: "INSERT INTO memories (content) VALUES (?)",
            duration: 15,
            rowsAffected: 1,
            success: true
        });

        const summary = collector.getMetricsSummary();
        expect(summary.vector.totalOperations).toBe(1);
        expect(summary.database.totalQueries).toBe(1);
        expect(summary.system.uptime).toBeGreaterThan(0);
        expect(summary.timestamp).toBeGreaterThan(0);
    });

    it("should handle failed operations correctly", () => {
        collector.recordVectorOperation({
            operation: 'embedding',
            duration: 500,
            vectorCount: 1,
            dimensions: 384,
            success: false,
            error: "Embedding service unavailable"
        });

        const stats = collector.getVectorOperationStats();
        expect(stats.totalOperations).toBe(1);
        expect(stats.successRate).toBe(0);
    });

    it("should track slowest operations", () => {
        // Record multiple operations with different durations
        collector.recordVectorOperation({
            operation: 'embedding',
            duration: 100,
            vectorCount: 1,
            dimensions: 384,
            success: true
        });

        collector.recordVectorOperation({
            operation: 'similarity',
            duration: 500,
            vectorCount: 10,
            dimensions: 384,
            success: true
        });

        collector.recordVectorOperation({
            operation: 'search',
            duration: 200,
            vectorCount: 5,
            dimensions: 384,
            success: true
        });

        const stats = collector.getVectorOperationStats();
        expect(stats.slowestOperations).toHaveLength(3);
        expect(stats.slowestOperations[0].duration).toBe(500); // Slowest first
        expect(stats.slowestOperations[0].operation).toBe('similarity');
    });

    it("should clear metrics when requested", () => {
        collector.recordVectorOperation({
            operation: 'embedding',
            duration: 100,
            vectorCount: 1,
            dimensions: 384,
            success: true
        });

        let stats = collector.getVectorOperationStats();
        expect(stats.totalOperations).toBe(1);

        collector.clearMetrics();
        stats = collector.getVectorOperationStats();
        expect(stats.totalOperations).toBe(0);
    });
});