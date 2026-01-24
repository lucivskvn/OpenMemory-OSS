/**
 * @file OpenMemory Resilient Test Framework Configuration
 * Centralized configuration for memory-aware test execution and OOM prevention
 */

export interface TestPhaseConfig {
    /** Phase identifier */
    id: string;
    /** Human-readable phase name */
    name: string;
    /** Detailed description of what this phase tests */
    description: string;
    /** Test file patterns to execute */
    patterns: string[];
    /** Timeout in milliseconds */
    timeout: number;
    /** Memory limit in MB (percentage of system memory) */
    memoryLimitPercent: number;
    /** Whether to run tests in isolated processes */
    isolateProcess: boolean;
    /** Whether this phase is critical (must pass for suite to continue) */
    critical: boolean;
    /** Retry attempts on failure */
    retryAttempts: number;
}

export interface TestFrameworkConfig {
    /** System memory detection and limits */
    memory: {
        /** Minimum system memory required (GB) */
        minimumSystemMemoryGB: number;
        /** Maximum heap size cap (MB) */
        maxHeapSizeMB: number;
        /** Memory warning threshold (percentage) */
        warningThreshold: number;
        /** Memory critical threshold (percentage) */
        criticalThreshold: number;
        /** Memory check interval (ms) */
        checkInterval: number;
    };
    /** Timeout configuration */
    timeouts: {
        /** Default test timeout (ms) */
        defaultTest: number;
        /** Unit test timeout (ms) */
        unit: number;
        /** Integration test timeout (ms) */
        integration: number;
        /** E2E test timeout (ms) */
        e2e: number;
        /** Performance test timeout (ms) */
        performance: number;
        /** Property test timeout (ms) */
        property: number;
        /** Watchdog buffer multiplier */
        watchdogBuffer: number;
    };
    /** Process management */
    processes: {
        /** Maximum concurrent processes */
        maxConcurrent: number;
        /** Process cleanup timeout (ms) */
        cleanupTimeout: number;
        /** Orphaned process check interval (ms) */
        orphanCheckInterval: number;
        /** Force kill escalation timeout (ms) */
        forceKillTimeout: number;
    };
    /** Test phases configuration */
    phases: TestPhaseConfig[];
}

/**
 * Detect system memory and calculate optimal configuration
 */
function detectSystemConfiguration(): { memoryGB: number; maxHeapMB: number } {
    try {
        // Get system memory from Node.js process
        const memoryUsage = process.memoryUsage();
        const systemMemoryGB = Math.max(
            Math.floor(memoryUsage.heapTotal / (1024 * 1024 * 1024)),
            4 // Minimum 4GB assumption
        );
        
        // Calculate max heap size (cap at 8GB for stability)
        const maxHeapMB = Math.min(systemMemoryGB * 1024 * 0.8, 8192);
        
        return { memoryGB: systemMemoryGB, maxHeapMB };
    } catch (error) {
        // Fallback to conservative defaults
        return { memoryGB: 4, maxHeapMB: 3200 };
    }
}

/**
 * Get the default test framework configuration
 */
export function getTestFrameworkConfig(): TestFrameworkConfig {
    const { memoryGB, maxHeapMB } = detectSystemConfiguration();
    
    return {
        memory: {
            minimumSystemMemoryGB: 2,
            maxHeapSizeMB: maxHeapMB,
            warningThreshold: 0.85,
            criticalThreshold: 0.95,
            checkInterval: 2000
        },
        timeouts: {
            defaultTest: 30000,
            unit: 15000,
            integration: 30000,
            e2e: 60000,
            performance: 90000,
            property: 120000,
            watchdogBuffer: 1.5
        },
        processes: {
            maxConcurrent: Math.max(2, Math.floor(memoryGB / 2)),
            cleanupTimeout: 10000,
            orphanCheckInterval: 30000,
            forceKillTimeout: 5000
        },
        phases: [
            {
                id: 'core-infrastructure',
                name: 'Core Infrastructure Validation',
                description: 'Database, security, and configuration validation',
                patterns: [
                    './test/core/db.test.ts',
                    './test/core/security.test.ts',
                    './test/core/cfg.test.ts'
                ],
                timeout: 15000,
                memoryLimitPercent: 0.2, // 20% of available memory
                isolateProcess: false,
                critical: true,
                retryAttempts: 2
            },
            {
                id: 'memory-engine',
                name: 'Memory Engine Verification',
                description: 'HSG engine, embeddings, and vector operations',
                patterns: [
                    './test/phase2-memory-engine.test.ts',
                    './test/memory/*.test.ts'
                ],
                timeout: 25000,
                memoryLimitPercent: 0.4, // 40% of available memory
                isolateProcess: true, // Memory-intensive, run in isolation
                critical: true,
                retryAttempts: 1
            },
            {
                id: 'api-server',
                name: 'API Server Integration',
                description: 'ElysiaJS routes, middleware, and server functionality',
                patterns: [
                    './tests/server_smoke.test.ts',
                    './test/server/*.test.ts'
                ],
                timeout: 20000,
                memoryLimitPercent: 0.3, // 30% of available memory
                isolateProcess: false,
                critical: true,
                retryAttempts: 2
            },
            {
                id: 'end-to-end',
                name: 'End-to-End Workflows',
                description: 'CLI integration and client workflows',
                patterns: [
                    './test/integration/coreInfra.test.ts',
                    './test/integration/dedup.test.ts',
                    './test/e2e/*.test.ts'
                ],
                timeout: 45000,
                memoryLimitPercent: 0.5, // 50% of available memory
                isolateProcess: true, // E2E tests can be memory-intensive
                critical: true,
                retryAttempts: 1
            },
            {
                id: 'performance',
                name: 'Performance & Load Testing',
                description: 'Benchmarks, stress tests, and performance validation',
                patterns: [
                    './test/performance/*.test.ts'
                ],
                timeout: 90000,
                memoryLimitPercent: 0.6, // 60% of available memory
                isolateProcess: true, // Performance tests need isolation
                critical: false, // Non-critical for basic functionality
                retryAttempts: 0
            },
            {
                id: 'property-based',
                name: 'Property-Based Correctness',
                description: 'Universal properties and correctness validation',
                patterns: [
                    './test/property/*.test.ts'
                ],
                timeout: 120000,
                memoryLimitPercent: 0.4, // 40% of available memory
                isolateProcess: true, // Property tests can generate many test cases
                critical: false, // Non-critical for basic functionality
                retryAttempts: 0
            }
        ]
    };
}

/**
 * Get configuration for a specific test phase
 */
export function getPhaseConfig(phaseId: string): TestPhaseConfig | undefined {
    const config = getTestFrameworkConfig();
    return config.phases.find(phase => phase.id === phaseId);
}

/**
 * Calculate memory limit in MB for a phase
 */
export function calculateMemoryLimit(phase: TestPhaseConfig): number {
    const config = getTestFrameworkConfig();
    return Math.round(config.memory.maxHeapSizeMB * phase.memoryLimitPercent);
}

/**
 * Get environment variables for test execution
 */
export function getTestEnvironment(phase?: TestPhaseConfig): Record<string, string> {
    const config = getTestFrameworkConfig();
    const memoryLimit = phase ? calculateMemoryLimit(phase) : config.memory.maxHeapSizeMB;
    
    const baseEnv = {
        OM_TIER: "local",
        OM_EMBEDDINGS: "local",
        OM_DB_PATH: ":memory:",
        OM_LOG_LEVEL: "error",
        OM_TELEMETRY_ENABLED: "false",
        OM_TEST_MODE: "true",
        OM_API_KEYS: "test-key-123",
        OM_ADMIN_KEY: "admin-test-key-456",
        OM_REDIS_URL: "redis://localhost:6379",
        NODE_OPTIONS: `--max-old-space-size=${memoryLimit}`
    };

    // Add garbage collection exposure for isolated processes
    if (phase?.isolateProcess) {
        baseEnv.NODE_OPTIONS += ' --expose-gc';
    }

    return baseEnv;
}

/**
 * Validate system requirements
 */
export function validateSystemRequirements(): { valid: boolean; issues: string[] } {
    const config = getTestFrameworkConfig();
    const issues: string[] = [];
    
    // Check minimum memory
    const { memoryGB } = detectSystemConfiguration();
    if (memoryGB < config.memory.minimumSystemMemoryGB) {
        issues.push(`Insufficient system memory: ${memoryGB}GB (minimum: ${config.memory.minimumSystemMemoryGB}GB)`);
    }
    
    // Check Node.js version (Bun compatibility)
    const nodeVersion = process.version;
    if (!nodeVersion.startsWith('v') || parseInt(nodeVersion.slice(1)) < 18) {
        issues.push(`Node.js version ${nodeVersion} may not be compatible (recommend Node 18+)`);
    }
    
    return {
        valid: issues.length === 0,
        issues
    };
}

/**
 * Get test framework summary for logging
 */
export function getFrameworkSummary(): string {
    const config = getTestFrameworkConfig();
    const { memoryGB } = detectSystemConfiguration();
    
    const lines = [
        '🚀 OpenMemory Resilient Test Framework',
        '=====================================',
        `🧠 System Memory: ${memoryGB}GB`,
        `📊 Max Heap Size: ${config.memory.maxHeapSizeMB}MB`,
        `⚠️  Memory Warning: ${Math.round(config.memory.warningThreshold * 100)}%`,
        `🚨 Memory Critical: ${Math.round(config.memory.criticalThreshold * 100)}%`,
        `🔄 Max Concurrent: ${config.processes.maxConcurrent} processes`,
        `📋 Test Phases: ${config.phases.length} configured`,
        ''
    ];
    
    return lines.join('\n');
}

/**
 * Export default configuration instance
 */
export const testFrameworkConfig = getTestFrameworkConfig();