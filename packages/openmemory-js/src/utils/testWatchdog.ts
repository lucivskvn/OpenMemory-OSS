/**
 * @file Test Watchdog
 * Provides automatic termination of stuck tests with escalating kill strategies
 */

import { logger } from "./logger";

export interface WatchdogConfig {
    /** Maximum test execution time in milliseconds */
    maxExecutionTime: number;
    /** Warning threshold (percentage of max time) */
    warningThreshold?: number;
    /** Check interval in milliseconds */
    checkInterval?: number;
    /** Whether to force kill the entire process */
    forceKillProcess?: boolean;
    /** Custom cleanup function before termination */
    onBeforeTerminate?: () => Promise<void>;
}

export interface TestExecution {
    id: string;
    name: string;
    startTime: number;
    maxTime: number;
    warningThreshold?: number;
    onTimeout?: () => Promise<void>;
}

/**
 * Global test watchdog that monitors and terminates stuck tests
 */
class TestWatchdog {
    private executions = new Map<string, TestExecution>();
    private watchdogTimer?: Timer;
    private isActive = false;
    private config: WatchdogConfig;

    constructor(config: WatchdogConfig) {
        this.config = {
            checkInterval: 5000, // Check every 5 seconds
            warningThreshold: 0.8, // Warn at 80%
            forceKillProcess: true,
            ...config
        };
    }

    /**
     * Start the watchdog monitoring
     */
    start(): void {
        if (this.isActive) return;

        this.isActive = true;
        logger.info(`[WATCHDOG] Started with ${this.config.maxExecutionTime}ms max execution time`);

        this.watchdogTimer = setInterval(() => {
            this.checkExecutions();
        }, this.config.checkInterval);

        // Set up emergency termination
        this.setupEmergencyTermination();
    }

    /**
     * Stop the watchdog monitoring
     */
    stop(): void {
        if (!this.isActive) return;

        this.isActive = false;
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }

        logger.info("[WATCHDOG] Stopped");
    }

    /**
     * Register a test execution for monitoring
     */
    registerExecution(execution: TestExecution): void {
        this.executions.set(execution.id, execution);
        logger.debug(`[WATCHDOG] Registered execution: ${execution.name} (${execution.id})`);
    }

    /**
     * Unregister a test execution
     */
    unregisterExecution(id: string): void {
        const execution = this.executions.get(id);
        if (execution) {
            this.executions.delete(id);
            logger.debug(`[WATCHDOG] Unregistered execution: ${execution.name} (${id})`);
        }
    }

    /**
     * Check all registered executions for timeouts
     */
    private async checkExecutions(): Promise<void> {
        const now = Date.now();

        for (const [id, execution] of this.executions.entries()) {
            const elapsed = now - execution.startTime;
            const remaining = execution.maxTime - elapsed;

            // Check for warning threshold
            if (execution.warningThreshold && 
                elapsed >= execution.maxTime * execution.warningThreshold &&
                elapsed < execution.maxTime) {
                logger.warn(`[WATCHDOG] Warning: ${execution.name} has been running for ${elapsed}ms (${remaining}ms remaining)`);
            }

            // Check for timeout
            if (elapsed >= execution.maxTime) {
                logger.error(`[WATCHDOG] TIMEOUT: ${execution.name} exceeded ${execution.maxTime}ms, terminating...`);
                await this.terminateExecution(id, execution);
            }
        }
    }

    /**
     * Terminate a stuck execution
     */
    private async terminateExecution(id: string, execution: TestExecution): Promise<void> {
        try {
            // Run custom timeout handler if provided
            if (execution.onTimeout) {
                await execution.onTimeout();
            }

            // Run global cleanup
            if (this.config.onBeforeTerminate) {
                await this.config.onBeforeTerminate();
            }

            // Remove from tracking
            this.unregisterExecution(id);

            // Force kill if configured
            if (this.config.forceKillProcess) {
                await this.forceKillProcess();
            }

        } catch (error) {
            logger.error(`[WATCHDOG] Failed to terminate execution ${execution.name}:`, error);
            
            // Emergency kill as last resort
            await this.emergencyKill();
        }
    }

    /**
     * Force kill the current process
     */
    private async forceKillProcess(): Promise<void> {
        logger.error("[WATCHDOG] Force killing process due to stuck test");

        try {
            // Try graceful exit first
            process.exit(1);
        } catch {
            // If graceful exit fails, use platform-specific kill
            await this.emergencyKill();
        }
    }

    /**
     * Emergency kill using platform-specific commands
     */
    private async emergencyKill(): Promise<void> {
        logger.error("[WATCHDOG] Emergency kill activated");

        try {
            if (process.platform === 'win32') {
                // Kill the entire process tree on Windows
                await Bun.spawn(['taskkill', '/F', '/T', '/PID', process.pid.toString()], {
                    stdout: 'ignore',
                    stderr: 'ignore'
                });
            } else {
                // Kill process group on Unix-like systems
                process.kill(-process.pid, 'SIGKILL');
            }
        } catch (error) {
            logger.error("[WATCHDOG] Emergency kill failed:", error);
            // Last resort - crash the process
            process.abort();
        }
    }

    /**
     * Set up emergency termination handlers
     */
    private setupEmergencyTermination(): void {
        // Set up absolute maximum execution time
        const absoluteMaxTime = this.config.maxExecutionTime * 2; // Double the configured time
        
        setTimeout(() => {
            if (this.isActive && this.executions.size > 0) {
                logger.error(`[WATCHDOG] EMERGENCY: Absolute maximum time (${absoluteMaxTime}ms) exceeded, force killing process`);
                this.emergencyKill();
            }
        }, absoluteMaxTime);

        // Handle memory exhaustion
        process.on('uncaughtException', (error) => {
            if (error.message.includes('memory') || error.message.includes('exhausted')) {
                logger.error("[WATCHDOG] Memory exhaustion detected, emergency kill");
                this.emergencyKill();
            }
        });

        // Handle unhandled rejections that might indicate stuck promises
        let unhandledRejectionCount = 0;
        process.on('unhandledRejection', (reason) => {
            unhandledRejectionCount++;
            if (unhandledRejectionCount > 10) { // Too many unhandled rejections
                logger.error("[WATCHDOG] Too many unhandled rejections, emergency kill");
                this.emergencyKill();
            }
        });
    }

    /**
     * Get current execution status
     */
    getExecutionStatus(): Array<{
        id: string;
        name: string;
        elapsed: number;
        remaining: number;
        progress: number;
    }> {
        const now = Date.now();
        return Array.from(this.executions.values()).map(execution => ({
            id: execution.id,
            name: execution.name,
            elapsed: now - execution.startTime,
            remaining: Math.max(0, execution.maxTime - (now - execution.startTime)),
            progress: Math.min(1, (now - execution.startTime) / execution.maxTime)
        }));
    }
}

// Export the TestWatchdog class for direct usage
export { TestWatchdog };

/**
 * Monitor a spawned process with timeout
 */
export function monitorSpawnedProcess(proc: any, timeout: number, name: string): void {
    const executionId = registerTestExecution(name, timeout, async () => {
        logger.error(`[WATCHDOG] Process ${name} timed out, killing...`);
        try {
            proc.kill();
        } catch (error) {
            logger.error(`[WATCHDOG] Failed to kill process ${name}:`, error);
        }
    });

    // Clean up when process exits
    proc.exited.finally(() => {
        unregisterTestExecution(executionId);
    });
}

/**
 * Run a test function with E2E timeout protection
 */
export async function withE2ETimeout<T>(
    testFn: (signal: AbortSignal) => Promise<T>,
    options?: { testName?: string; killProcess?: boolean; timeout?: number }
): Promise<{ timedOut: boolean; result?: T }> {
    const timeout = options?.timeout || 120000;
    const testName = options?.testName || "E2E Test";
    
    const controller = new AbortController();
    let timedOut = false;
    
    const executionId = registerTestExecution(testName, timeout, async () => {
        logger.error(`[WATCHDOG] ${testName} timed out, aborting...`);
        timedOut = true;
        controller.abort();
        
        if (options?.killProcess !== false) {
            // Default behavior: kill process on timeout
            process.exit(1);
        }
    });

    try {
        const result = await testFn(controller.signal);
        unregisterTestExecution(executionId);
        return { timedOut: false, result };
    } catch (error) {
        unregisterTestExecution(executionId);
        if (timedOut) {
            return { timedOut: true };
        }
        throw error;
    }
}

// Add static methods for backward compatibility
TestWatchdog.monitorSpawnedProcess = monitorSpawnedProcess;
TestWatchdog.withE2ETimeout = withE2ETimeout;

// Global watchdog instance
let globalWatchdog: TestWatchdog | undefined;

/**
 * Initialize the global test watchdog
 */
export function initializeTestWatchdog(config: WatchdogConfig): void {
    if (globalWatchdog) {
        globalWatchdog.stop();
    }

    globalWatchdog = new TestWatchdog(config);
    globalWatchdog.start();
}

/**
 * Stop the global test watchdog
 */
export function stopTestWatchdog(): void {
    if (globalWatchdog) {
        globalWatchdog.stop();
        globalWatchdog = undefined;
    }
}

/**
 * Register a test execution with the watchdog
 */
export function registerTestExecution(
    name: string,
    maxTime?: number,
    onTimeout?: () => Promise<void>
): string {
    if (!globalWatchdog) {
        // Auto-initialize with default config if not already initialized
        initializeTestWatchdog({
            maxExecutionTime: 300000, // 5 minutes default
            forceKillProcess: true
        });
    }

    const id = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const execution: TestExecution = {
        id,
        name,
        startTime: Date.now(),
        maxTime: maxTime || 30000, // 30 seconds default
        warningThreshold: 0.8,
        onTimeout
    };

    globalWatchdog!.registerExecution(execution);
    return id;
}

/**
 * Unregister a test execution
 */
export function unregisterTestExecution(id: string): void {
    if (globalWatchdog) {
        globalWatchdog.unregisterExecution(id);
    }
}

/**
 * Wrapper function to run a test with automatic watchdog protection
 */
export async function runWithWatchdog<T>(
    testName: string,
    testFn: () => Promise<T>,
    maxTime: number = 30000
): Promise<T> {
    const executionId = registerTestExecution(testName, maxTime, async () => {
        logger.error(`[WATCHDOG] Test ${testName} timed out, running cleanup`);
        
        // Import and run cleanup
        try {
            const { testProcessManager } = await import("./testProcessManager");
            await testProcessManager.stopAllProcesses();
            
            const { emergencyCleanup } = await import("./testCleanup");
            await emergencyCleanup();
        } catch (error) {
            logger.error("[WATCHDOG] Cleanup failed:", error);
        }
    });

    try {
        const result = await testFn();
        unregisterTestExecution(executionId);
        return result;
    } catch (error) {
        unregisterTestExecution(executionId);
        throw error;
    }
}

/**
 * Get current watchdog status
 */
export function getWatchdogStatus(): {
    active: boolean;
    executions: Array<{
        id: string;
        name: string;
        elapsed: number;
        remaining: number;
        progress: number;
    }>;
} {
    return {
        active: globalWatchdog !== undefined,
        executions: globalWatchdog?.getExecutionStatus() || []
    };
}

// Auto-cleanup on process exit
process.on('exit', () => {
    stopTestWatchdog();
});

process.on('SIGINT', () => {
    stopTestWatchdog();
    process.exit(1);
});

process.on('SIGTERM', () => {
    stopTestWatchdog();
    process.exit(1);
});