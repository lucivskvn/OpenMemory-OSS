/**
 * @file Health Checker Tests
 * Tests for the enhanced health check system
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HealthChecker } from "../../src/utils/healthChecker";

describe("HealthChecker", () => {
    let checker: HealthChecker;

    beforeEach(() => {
        checker = new HealthChecker();
    });

    it("should perform quick health check", async () => {
        const result = await checker.quickHealthCheck();
        
        expect(result).toHaveProperty('healthy');
        expect(typeof result.healthy).toBe('boolean');
        
        if (!result.healthy) {
            expect(result.message).toBeDefined();
        }
    });

    it("should run comprehensive health checks", async () => {
        const report = await checker.runHealthChecks();
        
        expect(report).toHaveProperty('overall');
        expect(report).toHaveProperty('checks');
        expect(report).toHaveProperty('timestamp');
        expect(report).toHaveProperty('uptime');
        expect(report).toHaveProperty('version');
        
        expect(['healthy', 'degraded', 'unhealthy']).toContain(report.overall);
        expect(Array.isArray(report.checks)).toBe(true);
        expect(report.checks.length).toBeGreaterThan(0);
        
        // Check that all default checks are present
        const checkNames = report.checks.map(c => c.name);
        expect(checkNames).toContain('database');
        expect(checkNames).toContain('memory');
        expect(checkNames).toContain('disk');
        expect(checkNames).toContain('vector_store');
        expect(checkNames).toContain('embedding_service');
    });

    it("should register and run custom health checks", async () => {
        const customCheckName = 'custom_test';
        let customCheckCalled = false;
        
        checker.registerCheck(customCheckName, async () => {
            customCheckCalled = true;
            return {
                name: customCheckName,
                status: 'healthy',
                message: 'Custom check passed'
            };
        });
        
        const report = await checker.runHealthChecks();
        
        expect(customCheckCalled).toBe(true);
        const customCheck = report.checks.find(c => c.name === customCheckName);
        expect(customCheck).toBeDefined();
        expect(customCheck?.status).toBe('healthy');
        expect(customCheck?.message).toBe('Custom check passed');
    });

    it("should handle failing health checks gracefully", async () => {
        const failingCheckName = 'failing_test';
        
        checker.registerCheck(failingCheckName, async () => {
            throw new Error('Simulated failure');
        });
        
        const report = await checker.runHealthChecks();
        
        const failingCheck = report.checks.find(c => c.name === failingCheckName);
        expect(failingCheck).toBeDefined();
        expect(failingCheck?.status).toBe('unhealthy');
        expect(failingCheck?.message).toContain('Simulated failure');
    });

    it("should handle timeout in health checks", async () => {
        const timeoutCheckName = 'timeout_test';
        
        checker.registerCheck(timeoutCheckName, async () => {
            // Simulate a check that takes too long
            await new Promise(resolve => setTimeout(resolve, 6000)); // 6 seconds > 5 second timeout
            return {
                name: timeoutCheckName,
                status: 'healthy',
                message: 'Should not reach here'
            };
        });
        
        const report = await checker.runHealthChecks();
        
        const timeoutCheck = report.checks.find(c => c.name === timeoutCheckName);
        expect(timeoutCheck).toBeDefined();
        expect(timeoutCheck?.status).toBe('unhealthy');
        expect(timeoutCheck?.message).toContain('timeout');
    }, 10000); // 10 second test timeout

    it("should determine overall health status correctly", async () => {
        // Test with all healthy checks
        checker.registerCheck('healthy1', async () => ({
            name: 'healthy1',
            status: 'healthy',
            message: 'OK'
        }));
        
        checker.registerCheck('healthy2', async () => ({
            name: 'healthy2',
            status: 'healthy',
            message: 'OK'
        }));
        
        let report = await checker.runHealthChecks();
        expect(report.overall).toBe('healthy');
        
        // Add a degraded check
        checker.registerCheck('degraded1', async () => ({
            name: 'degraded1',
            status: 'degraded',
            message: 'Slow but working'
        }));
        
        report = await checker.runHealthChecks();
        expect(report.overall).toBe('degraded');
        
        // Add an unhealthy check
        checker.registerCheck('unhealthy1', async () => ({
            name: 'unhealthy1',
            status: 'unhealthy',
            message: 'Failed'
        }));
        
        report = await checker.runHealthChecks();
        expect(report.overall).toBe('unhealthy');
    });

    it("should include duration in health check results", async () => {
        checker.registerCheck('timed_check', async () => {
            await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
            return {
                name: 'timed_check',
                status: 'healthy',
                message: 'Completed with delay'
            };
        });
        
        const report = await checker.runHealthChecks();
        const timedCheck = report.checks.find(c => c.name === 'timed_check');
        
        expect(timedCheck).toBeDefined();
        expect(timedCheck?.duration).toBeDefined();
        expect(timedCheck?.duration).toBeGreaterThanOrEqual(100);
    });

    it("should validate memory usage check", async () => {
        const report = await checker.runHealthChecks();
        const memoryCheck = report.checks.find(c => c.name === 'memory');
        
        expect(memoryCheck).toBeDefined();
        expect(memoryCheck?.details).toBeDefined();
        expect(memoryCheck?.details?.heapUsed).toBeGreaterThan(0);
        expect(memoryCheck?.details?.heapTotal).toBeGreaterThan(0);
        expect(memoryCheck?.details?.rss).toBeGreaterThan(0);
        expect(memoryCheck?.details?.heapUsagePercent).toBeGreaterThan(0);
    });

    it("should validate vector store check", async () => {
        const report = await checker.runHealthChecks();
        const vectorCheck = report.checks.find(c => c.name === 'vector_store');
        
        expect(vectorCheck).toBeDefined();
        expect(['healthy', 'degraded', 'unhealthy']).toContain(vectorCheck?.status);
        
        if (vectorCheck?.status === 'healthy' || vectorCheck?.status === 'degraded') {
            expect(vectorCheck.details?.operationTime).toBeDefined();
        }
    });

    it("should validate embedding service check", async () => {
        const report = await checker.runHealthChecks();
        const embeddingCheck = report.checks.find(c => c.name === 'embedding_service');
        
        expect(embeddingCheck).toBeDefined();
        expect(['healthy', 'degraded', 'unhealthy']).toContain(embeddingCheck?.status);
        expect(embeddingCheck?.details?.model).toBeDefined();
        expect(embeddingCheck?.details?.url).toBeDefined();
    });
});