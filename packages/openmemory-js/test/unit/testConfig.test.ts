/**
 * @file Test Configuration Validation
 * Tests for the OpenMemory Resilient Test Framework configuration
 */

import { describe, test, expect } from "bun:test";
import { 
    getTestFrameworkConfig, 
    getPhaseConfig, 
    calculateMemoryLimit,
    getTestEnvironment,
    validateSystemRequirements,
    getFrameworkSummary
} from "../../src/utils/testConfig";

describe("OpenMemory Resilient Test Framework Configuration", () => {
    
    test("should provide valid framework configuration", () => {
        const config = getTestFrameworkConfig();
        
        expect(config).toBeDefined();
        expect(config.memory).toBeDefined();
        expect(config.timeouts).toBeDefined();
        expect(config.processes).toBeDefined();
        expect(config.phases).toBeDefined();
        
        // Memory configuration validation
        expect(config.memory.maxHeapSizeMB).toBeGreaterThan(0);
        expect(config.memory.warningThreshold).toBeGreaterThan(0);
        expect(config.memory.warningThreshold).toBeLessThan(1);
        expect(config.memory.criticalThreshold).toBeGreaterThan(config.memory.warningThreshold);
        
        // Timeout configuration validation
        expect(config.timeouts.defaultTest).toBeGreaterThan(0);
        expect(config.timeouts.unit).toBeGreaterThan(0);
        expect(config.timeouts.integration).toBeGreaterThan(config.timeouts.unit);
        expect(config.timeouts.e2e).toBeGreaterThan(config.timeouts.integration);
        
        // Process configuration validation
        expect(config.processes.maxConcurrent).toBeGreaterThan(0);
        expect(config.processes.cleanupTimeout).toBeGreaterThan(0);
        
        // Phases validation
        expect(config.phases.length).toBeGreaterThan(0);
        config.phases.forEach(phase => {
            expect(phase.id).toBeDefined();
            expect(phase.name).toBeDefined();
            expect(phase.description).toBeDefined();
            expect(phase.patterns.length).toBeGreaterThan(0);
            expect(phase.timeout).toBeGreaterThan(0);
            expect(phase.memoryLimitPercent).toBeGreaterThan(0);
            expect(phase.memoryLimitPercent).toBeLessThanOrEqual(1);
        });
    });
    
    test("should retrieve specific phase configuration", () => {
        const corePhase = getPhaseConfig('core-infrastructure');
        
        expect(corePhase).toBeDefined();
        expect(corePhase?.id).toBe('core-infrastructure');
        expect(corePhase?.name).toBe('Core Infrastructure Validation');
        expect(corePhase?.critical).toBe(true);
        expect(corePhase?.patterns.length).toBeGreaterThan(0);
        
        // Non-existent phase should return undefined
        const nonExistent = getPhaseConfig('non-existent-phase');
        expect(nonExistent).toBeUndefined();
    });
    
    test("should calculate memory limits correctly", () => {
        const config = getTestFrameworkConfig();
        const corePhase = getPhaseConfig('core-infrastructure');
        
        if (corePhase) {
            const memoryLimit = calculateMemoryLimit(corePhase);
            
            expect(memoryLimit).toBeGreaterThan(0);
            expect(memoryLimit).toBeLessThanOrEqual(config.memory.maxHeapSizeMB);
            
            // Should be approximately 20% of max heap size for core phase
            const expectedLimit = Math.round(config.memory.maxHeapSizeMB * corePhase.memoryLimitPercent);
            expect(memoryLimit).toBe(expectedLimit);
        }
    });
    
    test("should provide proper test environment variables", () => {
        const env = getTestEnvironment();
        
        // Check required environment variables
        expect(env.OM_TIER).toBe("local");
        expect(env.OM_EMBEDDINGS).toBe("local");
        expect(env.OM_DB_PATH).toBe(":memory:");
        expect(env.OM_LOG_LEVEL).toBe("error");
        expect(env.OM_TELEMETRY_ENABLED).toBe("false");
        expect(env.OM_TEST_MODE).toBe("true");
        expect(env.OM_API_KEYS).toBeDefined();
        expect(env.OM_ADMIN_KEY).toBeDefined();
        expect(env.NODE_OPTIONS).toBeDefined();
        expect(env.NODE_OPTIONS).toContain("--max-old-space-size=");
        
        // Test with specific phase
        const memoryPhase = getPhaseConfig('memory-engine');
        if (memoryPhase) {
            const phaseEnv = getTestEnvironment(memoryPhase);
            expect(phaseEnv.NODE_OPTIONS).toContain("--expose-gc");
        }
    });
    
    test("should validate system requirements", () => {
        const validation = validateSystemRequirements();
        
        expect(validation).toBeDefined();
        expect(validation.valid).toBeDefined();
        expect(validation.issues).toBeDefined();
        expect(Array.isArray(validation.issues)).toBe(true);
        
        // If validation fails, issues should be provided
        if (!validation.valid) {
            expect(validation.issues.length).toBeGreaterThan(0);
        }
    });
    
    test("should generate framework summary", () => {
        const summary = getFrameworkSummary();
        
        expect(summary).toBeDefined();
        expect(typeof summary).toBe("string");
        expect(summary.length).toBeGreaterThan(0);
        expect(summary).toContain("OpenMemory Resilient Test Framework");
        expect(summary).toContain("System Memory:");
        expect(summary).toContain("Max Heap Size:");
        expect(summary).toContain("Test Phases:");
    });
    
    test("should have properly configured phase priorities", () => {
        const config = getTestFrameworkConfig();
        
        // Core infrastructure should be first and critical
        const corePhase = config.phases.find(p => p.id === 'core-infrastructure');
        expect(corePhase?.critical).toBe(true);
        
        // Memory engine should be critical
        const memoryPhase = config.phases.find(p => p.id === 'memory-engine');
        expect(memoryPhase?.critical).toBe(true);
        expect(memoryPhase?.isolateProcess).toBe(true);
        
        // Performance tests should be non-critical
        const perfPhase = config.phases.find(p => p.id === 'performance');
        expect(perfPhase?.critical).toBe(false);
        expect(perfPhase?.isolateProcess).toBe(true);
        
        // Property tests should be non-critical
        const propPhase = config.phases.find(p => p.id === 'property-based');
        expect(propPhase?.critical).toBe(false);
        expect(propPhase?.isolateProcess).toBe(true);
    });
    
    test("should have reasonable memory allocation across phases", () => {
        const config = getTestFrameworkConfig();
        
        // Total memory allocation should not exceed 100% for any single phase
        config.phases.forEach(phase => {
            expect(phase.memoryLimitPercent).toBeLessThanOrEqual(1.0);
            expect(phase.memoryLimitPercent).toBeGreaterThan(0);
        });
        
        // Memory-intensive phases should have higher allocations
        const memoryPhase = config.phases.find(p => p.id === 'memory-engine');
        const corePhase = config.phases.find(p => p.id === 'core-infrastructure');
        
        if (memoryPhase && corePhase) {
            expect(memoryPhase.memoryLimitPercent).toBeGreaterThan(corePhase.memoryLimitPercent);
        }
    });
    
    test("should have appropriate timeout escalation", () => {
        const config = getTestFrameworkConfig();
        
        // Timeouts should escalate appropriately
        expect(config.timeouts.unit).toBeLessThan(config.timeouts.integration);
        expect(config.timeouts.integration).toBeLessThan(config.timeouts.e2e);
        expect(config.timeouts.e2e).toBeLessThan(config.timeouts.performance);
        expect(config.timeouts.performance).toBeLessThan(config.timeouts.property);
        
        // Watchdog buffer should be reasonable
        expect(config.timeouts.watchdogBuffer).toBeGreaterThan(1.0);
        expect(config.timeouts.watchdogBuffer).toBeLessThan(3.0);
    });
});