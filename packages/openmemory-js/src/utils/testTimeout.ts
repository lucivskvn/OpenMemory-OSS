/**
 * @file Test Timeout Manager
 * Provides robust timeout handling for tests with escalating termination strategies
 */

import { logger } from "./logger";

export interface TimeoutConfig {
    /** Timeout duration in milliseconds */
    timeout: number;
    /** Warning threshold (percentage of timeout) */
    warningThreshold?: number;
    /** Whether to escalate termination signals */
    escalateSignals?: boolean;
    /** Custom cleanup function to run on timeout */
    onTimeout?: () => Promise<void>;
    /** Custom warning function to run at warning threshold */
    onWarning?: (remainingTime: number) => void;
}

export interface TimeoutHandle {
    /** Cancel the timeout */
    cancel: () => void;
    /** Check if timeout is still active */
    isActive: () => boolean;
    /** Get remaining time in milliseconds */
    getRemainingTime: () => number;
}

/**
 * Creates a robust timeout with warning and cleanup capabilities
 */
export function createTestTimeout(
    name: string,
    config: TimeoutConfig
): TimeoutHandle {
    const startTime = Date.now();
    let isActive = true;
    let timeoutId: Timer | undefined;
    let warningId: Timer | undefined;

    const cleanup = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
        }
        if (warningId) {
            clearTimeout(warningId);
            warningId = undefined;
        }
        isActive = false;
    };

    // Set up warning if threshold is specified
    if (config.warningThreshold && config.warningThreshold > 0 && config.warningThreshold < 1) {
        const warningTime = config.timeout * config.warningThreshold;
        warningId = setTimeout(() => {
            if (!isActive) return;
            
            const remainingTime = config.timeout - warningTime;
            logger.warn(`[TIMEOUT] Warning: ${name} has ${remainingTime}ms remaining`);
            
            if (config.onWarning) {
                config.onWarning(remainingTime);
            }
        }, warningTime);
    }

    // Set up main timeout
    timeoutId = setTimeout(async () => {
        if (!isActive) return;
        
        logger.error(`[TIMEOUT] ${name} timed out after ${config.timeout}ms`);
        
        try {
            // Run custom cleanup if provided
            if (config.onTimeout) {
                await config.onTimeout();
            }
            
            // Escalate termination signals if enabled
            if (config.escalateSignals) {
                await escalateTermination(name);
            }
        } catch (error) {
            logger.error(`[TIMEOUT] Cleanup failed for ${name}:`, error);
        } finally {
            cleanup();
        }
    }, config.timeout);

    return {
        cancel: cleanup,
        isActive: () => isActive,
        getRemainingTime: () => {
            if (!isActive) return 0;
            return Math.max(0, config.timeout - (Date.now() - startTime));
        }
    };
}

/**
 * Escalate termination signals for stuck processes
 */
async function escalateTermination(name: string): Promise<void> {
    logger.warn(`[TIMEOUT] Escalating termination for ${name}`);
    
    try {
        // Step 1: Send SIGTERM to current process group
        if (process.platform !== 'win32') {
            process.kill(-process.pid, 'SIGTERM');
        }
        
        // Wait 2 seconds for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Step 2: Send SIGKILL to current process group
        logger.warn(`[TIMEOUT] Sending SIGKILL to process group for ${name}`);
        if (process.platform !== 'win32') {
            process.kill(-process.pid, 'SIGKILL');
        } else {
            // On Windows, use taskkill to terminate the process tree
            await Bun.spawn(['taskkill', '/F', '/T', '/PID', process.pid.toString()], {
                stdout: 'ignore',
                stderr: 'ignore'
            });
        }
        
    } catch (error) {
        logger.error(`[TIMEOUT] Failed to escalate termination for ${name}:`, error);
    }
}

/**
 * Wrapper for test functions with automatic timeout handling
 */
export async function withTimeout<T>(
    name: string,
    fn: () => Promise<T>,
    config: TimeoutConfig
): Promise<T> {
    const timeoutHandle = createTestTimeout(name, config);
    
    try {
        const result = await Promise.race([
            fn(),
            new Promise<never>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`${name} timed out after ${config.timeout}ms`));
                }, config.timeout);
            })
        ]);
        
        timeoutHandle.cancel();
        return result;
        
    } catch (error) {
        timeoutHandle.cancel();
        throw error;
    }
}

/**
 * Create a timeout for test suites with automatic cleanup
 */
export function createTestSuiteTimeout(
    suiteName: string,
    timeout: number = 300000 // 5 minutes default
): TimeoutHandle {
    return createTestTimeout(`Test Suite: ${suiteName}`, {
        timeout,
        warningThreshold: 0.8, // Warn at 80% of timeout
        escalateSignals: true,
        onWarning: (remainingTime) => {
            logger.warn(`[TEST-SUITE] ${suiteName} is taking longer than expected. ${remainingTime}ms remaining.`);
        },
        onTimeout: async () => {
            logger.error(`[TEST-SUITE] ${suiteName} exceeded timeout. Forcing cleanup...`);
            
            // Force cleanup of any remaining processes
            const { testProcessManager } = await import("./testProcessManager");
            await testProcessManager.stopAllProcesses();
            
            // Force cleanup of test artifacts
            const { emergencyCleanup } = await import("./testCleanup");
            await emergencyCleanup();
        }
    });
}

/**
 * Create a timeout for individual tests
 */
export function createTestTimeout(
    testName: string,
    timeout: number = 30000 // 30 seconds default
): TimeoutHandle {
    return createTestTimeout(`Test: ${testName}`, {
        timeout,
        warningThreshold: 0.9, // Warn at 90% of timeout
        escalateSignals: false, // Don't escalate for individual tests
        onWarning: (remainingTime) => {
            logger.warn(`[TEST] ${testName} is running longer than expected. ${remainingTime}ms remaining.`);
        }
    });
}

/**
 * Utility to run a test with automatic timeout and cleanup
 */
export async function runTestWithTimeout<T>(
    testName: string,
    testFn: () => Promise<T>,
    timeout: number = 30000
): Promise<T> {
    return withTimeout(testName, testFn, {
        timeout,
        warningThreshold: 0.9,
        escalateSignals: false
    });
}

/**
 * Utility to run a test suite with automatic timeout and cleanup
 */
export async function runTestSuiteWithTimeout<T>(
    suiteName: string,
    suiteFn: () => Promise<T>,
    timeout: number = 300000
): Promise<T> {
    return withTimeout(suiteName, suiteFn, {
        timeout,
        warningThreshold: 0.8,
        escalateSignals: true,
        onTimeout: async () => {
            // Emergency cleanup for test suites
            const { testProcessManager } = await import("./testProcessManager");
            await testProcessManager.stopAllProcesses();
            
            const { emergencyCleanup } = await import("./testCleanup");
            await emergencyCleanup();
        }
    });
}

/**
 * Global timeout manager for tracking all active timeouts
 */
class GlobalTimeoutManager {
    private timeouts = new Map<string, TimeoutHandle>();
    
    register(name: string, handle: TimeoutHandle): void {
        this.timeouts.set(name, handle);
    }
    
    cancel(name: string): boolean {
        const handle = this.timeouts.get(name);
        if (handle) {
            handle.cancel();
            this.timeouts.delete(name);
            return true;
        }
        return false;
    }
    
    cancelAll(): void {
        for (const [name, handle] of this.timeouts.entries()) {
            handle.cancel();
        }
        this.timeouts.clear();
    }
    
    getActiveTimeouts(): string[] {
        return Array.from(this.timeouts.keys()).filter(name => {
            const handle = this.timeouts.get(name);
            return handle?.isActive();
        });
    }
}

export const globalTimeoutManager = new GlobalTimeoutManager();

// Set up cleanup on process exit
process.on('exit', () => {
    globalTimeoutManager.cancelAll();
});

process.on('SIGINT', () => {
    globalTimeoutManager.cancelAll();
});

process.on('SIGTERM', () => {
    globalTimeoutManager.cancelAll();
});