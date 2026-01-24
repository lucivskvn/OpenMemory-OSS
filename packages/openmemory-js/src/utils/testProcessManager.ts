/**
 * @file Test Process Manager
 * Provides robust process lifecycle management for test servers and background processes.
 * Implements graceful shutdown, timeout handling, and orphaned process detection.
 */

import { logger } from "./logger";

export interface ProcessConfig {
    /** Process identifier for tracking */
    id: string;
    /** Command to execute */
    command: string[];
    /** Working directory */
    cwd?: string;
    /** Environment variables */
    env?: Record<string, string>;
    /** Process timeout in milliseconds */
    timeout?: number;
    /** Whether to kill process on timeout */
    killOnTimeout?: boolean;
    /** Memory limit in MB */
    memoryLimit?: number;
    /** Whether to run in isolated process */
    isolateProcess?: boolean;
    /** Cleanup callback when process exits */
    onExit?: (code: number | null, signal: string | null) => void;
}

export interface ProcessInfo {
    id: string;
    pid: number;
    command: string[];
    startTime: number;
    status: 'running' | 'stopped' | 'killed' | 'timeout' | 'oom';
    memoryLimit?: number;
    memoryUsage?: number;
    subprocess: Subprocess;
}

/**
 * Manages test processes with proper lifecycle management
 */
export class TestProcessManager {
    private processes = new Map<string, ProcessInfo>();
    private shutdownHandlers = new Set<() => Promise<void>>();
    private isShuttingDown = false;
    private cleanupInterval?: Timer;

    constructor() {
        this.setupGlobalHandlers();
        this.startOrphanedProcessMonitor();
    }

    /**
     * Start a new test process with timeout and monitoring
     */
    async startProcess(config: ProcessConfig): Promise<ProcessInfo> {
        if (this.processes.has(config.id)) {
            throw new Error(`Process ${config.id} already exists`);
        }

        logger.debug(`[PROCESS] Starting process: ${config.id}`);

        try {
            // Prepare environment with memory management
            const processEnv = { ...process.env, ...config.env };
            
            // Add memory limit to Node.js options if specified
            if (config.memoryLimit) {
                const existingNodeOptions = processEnv.NODE_OPTIONS || '';
                const memoryOption = `--max-old-space-size=${config.memoryLimit}`;
                
                // Check if max-old-space-size is already set
                if (existingNodeOptions.includes('--max-old-space-size=')) {
                    // Replace existing memory limit
                    processEnv.NODE_OPTIONS = existingNodeOptions.replace(
                        /--max-old-space-size=\d+/,
                        memoryOption
                    );
                } else {
                    // Add memory limit
                    processEnv.NODE_OPTIONS = `${existingNodeOptions} ${memoryOption}`.trim();
                }
                
                logger.debug(`[PROCESS] Set memory limit for ${config.id}: ${config.memoryLimit}MB`);
            }

            // Add garbage collection exposure for memory monitoring
            if (config.isolateProcess && processEnv.NODE_OPTIONS) {
                if (!processEnv.NODE_OPTIONS.includes('--expose-gc')) {
                    processEnv.NODE_OPTIONS += ' --expose-gc';
                }
            }

            const subprocess = Bun.spawn(config.command, {
                cwd: config.cwd || process.cwd(),
                env: processEnv,
                stdout: 'pipe',
                stderr: 'pipe',
                stdin: 'ignore'
            });

            const processInfo: ProcessInfo = {
                id: config.id,
                pid: subprocess.pid,
                command: config.command,
                startTime: Date.now(),
                status: 'running',
                memoryLimit: config.memoryLimit,
                memoryUsage: 0,
                subprocess
            };

            this.processes.set(config.id, processInfo);

            // Set up memory monitoring if memory limit is specified
            if (config.memoryLimit) {
                this.startMemoryMonitoring(processInfo);
            }

            // Set up timeout handling if specified
            if (config.timeout && config.timeout > 0) {
                setTimeout(() => {
                    this.handleProcessTimeout(config.id, config.timeout!, config.killOnTimeout);
                }, config.timeout);
            }

            // Monitor process exit
            subprocess.exited.then((code) => {
                this.handleProcessExit(config.id, code, null);
                if (config.onExit) {
                    config.onExit(code, null);
                }
            }).catch((error) => {
                logger.error(`[PROCESS] Process ${config.id} error:`, error);
                this.handleProcessExit(config.id, null, 'ERROR');
            });

            logger.info(`[PROCESS] Started process ${config.id} (PID: ${subprocess.pid}${config.memoryLimit ? `, Memory: ${config.memoryLimit}MB` : ''})`);
            return processInfo;

        } catch (error) {
            logger.error(`[PROCESS] Failed to start process ${config.id}:`, error);
            throw error;
        }
    }

    /**
     * Stop a process gracefully with escalating signals
     */
    async stopProcess(id: string, timeout = 5000): Promise<boolean> {
        const processInfo = this.processes.get(id);
        if (!processInfo || processInfo.status !== 'running') {
            logger.warn(`[PROCESS] Process ${id} not found or not running`);
            return false;
        }

        logger.debug(`[PROCESS] Stopping process: ${id}`);

        try {
            // Step 1: Try SIGTERM (graceful shutdown)
            processInfo.subprocess.kill('SIGTERM');
            
            // Wait for graceful shutdown
            const gracefulShutdown = await this.waitForProcessExit(processInfo, timeout / 2);
            if (gracefulShutdown) {
                logger.info(`[PROCESS] Process ${id} stopped gracefully`);
                return true;
            }

            // Step 2: Try SIGKILL (force kill)
            logger.warn(`[PROCESS] Process ${id} did not respond to SIGTERM, using SIGKILL`);
            processInfo.subprocess.kill('SIGKILL');
            
            const forceKill = await this.waitForProcessExit(processInfo, timeout / 2);
            if (forceKill) {
                processInfo.status = 'killed';
                logger.info(`[PROCESS] Process ${id} force killed`);
                return true;
            }

            // Step 3: Platform-specific force kill
            await this.platformForceKill(processInfo.pid);
            processInfo.status = 'killed';
            logger.warn(`[PROCESS] Process ${id} required platform-specific force kill`);
            return true;

        } catch (error) {
            logger.error(`[PROCESS] Failed to stop process ${id}:`, error);
            return false;
        }
    }

    /**
     * Stop all managed processes
     */
    async stopAllProcesses(timeout = 10000): Promise<void> {
        if (this.processes.size === 0) {
            return;
        }

        logger.info(`[PROCESS] Stopping ${this.processes.size} processes...`);
        
        const stopPromises = Array.from(this.processes.keys()).map(id => 
            this.stopProcess(id, timeout / this.processes.size)
        );

        await Promise.allSettled(stopPromises);
        
        // Clear the processes map
        this.processes.clear();
        logger.info(`[PROCESS] All processes stopped`);
    }

    /**
     * Get information about a specific process
     */
    getProcess(id: string): ProcessInfo | undefined {
        return this.processes.get(id);
    }

    /**
     * Get all managed processes
     */
    getAllProcesses(): ProcessInfo[] {
        return Array.from(this.processes.values());
    }

    /**
     * Check if a process is running
     */
    isProcessRunning(id: string): boolean {
        const process = this.processes.get(id);
        return process?.status === 'running';
    }

    /**
     * Add a shutdown handler
     */
    addShutdownHandler(handler: () => Promise<void>): void {
        this.shutdownHandlers.add(handler);
    }

    /**
     * Remove a shutdown handler
     */
    removeShutdownHandler(handler: () => Promise<void>): void {
        this.shutdownHandlers.delete(handler);
    }

    /**
     * Handle process timeout
     */
    private async handleProcessTimeout(id: string, timeout: number, killOnTimeout = true): Promise<void> {
        const processInfo = this.processes.get(id);
        if (!processInfo || processInfo.status !== 'running') {
            return;
        }

        logger.warn(`[PROCESS] Process ${id} timed out after ${timeout}ms`);
        processInfo.status = 'timeout';

        if (killOnTimeout) {
            await this.stopProcess(id);
        }
    }

    /**
     * Handle process exit
     */
    private handleProcessExit(id: string, code: number | null, signal: string | null): void {
        const processInfo = this.processes.get(id);
        if (!processInfo) {
            return;
        }

        if (processInfo.status === 'running') {
            processInfo.status = 'stopped';
        }

        const runtime = Date.now() - processInfo.startTime;
        logger.debug(`[PROCESS] Process ${id} exited (code: ${code}, signal: ${signal}, runtime: ${runtime}ms)`);
    }

    /**
     * Wait for a process to exit
     */
    private async waitForProcessExit(processInfo: ProcessInfo, timeout: number): Promise<boolean> {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => resolve(false), timeout);
            
            processInfo.subprocess.exited.then(() => {
                clearTimeout(timeoutId);
                resolve(true);
            }).catch(() => {
                clearTimeout(timeoutId);
                resolve(false);
            });
        });
    }

    /**
     * Platform-specific force kill
     */
    private async platformForceKill(pid: number): Promise<void> {
        try {
            if (process.platform === 'win32') {
                await Bun.spawn(['taskkill', '/F', '/PID', pid.toString()], {
                    stdout: 'ignore',
                    stderr: 'ignore'
                });
            } else {
                await Bun.spawn(['kill', '-9', pid.toString()], {
                    stdout: 'ignore',
                    stderr: 'ignore'
                });
            }
        } catch (error) {
            logger.error(`[PROCESS] Platform force kill failed for PID ${pid}:`, error);
        }
    }

    /**
     * Set up global process handlers
     */
    private setupGlobalHandlers(): void {
        const handleShutdown = async (signal: string) => {
            if (this.isShuttingDown) {
                return;
            }
            
            this.isShuttingDown = true;
            logger.info(`[PROCESS] Received ${signal}, shutting down processes...`);

            // Run custom shutdown handlers
            const handlerPromises = Array.from(this.shutdownHandlers).map(handler => 
                handler().catch(error => 
                    logger.error('[PROCESS] Shutdown handler failed:', error)
                )
            );
            await Promise.allSettled(handlerPromises);

            // Stop all managed processes
            await this.stopAllProcesses();

            // Clear cleanup interval
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
            }

            logger.info(`[PROCESS] Shutdown complete`);
        };

        process.on('SIGINT', () => handleShutdown('SIGINT'));
        process.on('SIGTERM', () => handleShutdown('SIGTERM'));
        process.on('beforeExit', () => handleShutdown('beforeExit'));
        
        // Handle uncaught exceptions
        process.on('uncaughtException', async (error) => {
            logger.error('[PROCESS] Uncaught exception:', error);
            await handleShutdown('uncaughtException');
            process.exit(1);
        });

        process.on('unhandledRejection', async (reason) => {
            logger.error('[PROCESS] Unhandled rejection:', reason);
            await handleShutdown('unhandledRejection');
            process.exit(1);
        });
    }

    /**
     * Start monitoring for orphaned processes
     */
    private startOrphanedProcessMonitor(): void {
        // Check for orphaned processes every 30 seconds
        this.cleanupInterval = setInterval(() => {
            this.cleanupOrphanedProcesses();
        }, 30000);
    }

    /**
     * Start memory monitoring for a process
     */
    private startMemoryMonitoring(processInfo: ProcessInfo): void {
        if (!processInfo.memoryLimit) return;

        const monitorInterval = setInterval(async () => {
            if (processInfo.status !== 'running') {
                clearInterval(monitorInterval);
                return;
            }

            try {
                const memoryUsage = await this.getProcessMemoryUsage(processInfo.pid);
                processInfo.memoryUsage = memoryUsage;

                const memoryUsagePercent = memoryUsage / processInfo.memoryLimit!;

                // Log memory usage if it's getting high
                if (memoryUsagePercent > 0.8) {
                    logger.warn(`[PROCESS] High memory usage for ${processInfo.id}: ${memoryUsage}MB/${processInfo.memoryLimit}MB (${Math.round(memoryUsagePercent * 100)}%)`);
                }

                // Kill process if it exceeds memory limit
                if (memoryUsagePercent > 0.95) {
                    logger.error(`[PROCESS] Process ${processInfo.id} exceeded memory limit (${memoryUsage}MB/${processInfo.memoryLimit}MB), terminating`);
                    processInfo.status = 'oom';
                    await this.stopProcess(processInfo.id);
                    clearInterval(monitorInterval);
                }

            } catch (error) {
                logger.debug(`[PROCESS] Failed to get memory usage for ${processInfo.id}:`, error);
            }
        }, 2000); // Check every 2 seconds

        // Clean up interval when process exits
        processInfo.subprocess.exited.finally(() => {
            clearInterval(monitorInterval);
        });
    }

    /**
     * Get memory usage for a process in MB
     */
    private async getProcessMemoryUsage(pid: number): Promise<number> {
        try {
            if (process.platform === 'win32') {
                // Windows: Use tasklist to get memory usage
                const result = await Bun.spawn([
                    'powershell', 
                    '-Command', 
                    `Get-Process -Id ${pid} | Select-Object WorkingSet | ConvertTo-Json`
                ], {
                    stdout: 'pipe',
                    stderr: 'ignore'
                });
                
                const output = await result.text();
                const data = JSON.parse(output);
                return Math.round(data.WorkingSet / 1024 / 1024); // Convert bytes to MB
                
            } else {
                // Unix-like: Use ps to get memory usage
                const result = await Bun.spawn([
                    'ps', '-p', pid.toString(), '-o', 'rss='
                ], {
                    stdout: 'pipe',
                    stderr: 'ignore'
                });
                
                const output = await result.text();
                const rssKB = parseInt(output.trim());
                return Math.round(rssKB / 1024); // Convert KB to MB
            }
        } catch (error) {
            // If we can't get memory usage, return 0
            return 0;
        }
    }

    /**
     * Clean up orphaned processes
     */
    private async cleanupOrphanedProcesses(): Promise<void> {
        const now = Date.now();
        const orphanedProcesses: string[] = [];

        for (const [id, processInfo] of this.processes.entries()) {
            // Consider a process orphaned if it's been running for more than 5 minutes
            // and is marked as running but the subprocess has actually exited
            if (processInfo.status === 'running' && 
                (now - processInfo.startTime) > 300000) { // 5 minutes
                
                try {
                    // Check if process is actually still running
                    const isAlive = await this.isProcessAlive(processInfo.pid);
                    if (!isAlive) {
                        orphanedProcesses.push(id);
                    }
                } catch (error) {
                    logger.warn(`[PROCESS] Failed to check process ${id} status:`, error);
                    orphanedProcesses.push(id);
                }
            }
        }

        // Clean up orphaned processes
        for (const id of orphanedProcesses) {
            logger.warn(`[PROCESS] Cleaning up orphaned process: ${id}`);
            this.processes.delete(id);
        }
    }

    /**
     * Check if a process is still alive
     */
    private async isProcessAlive(pid: number): Promise<boolean> {
        try {
            if (process.platform === 'win32') {
                const result = await Bun.spawn(['tasklist', '/FI', `PID eq ${pid}`], {
                    stdout: 'pipe',
                    stderr: 'ignore'
                });
                const output = await result.text();
                return output.includes(pid.toString());
            } else {
                const result = await Bun.spawn(['kill', '-0', pid.toString()], {
                    stdout: 'ignore',
                    stderr: 'ignore'
                });
                return result.exitCode === 0;
            }
        } catch {
            return false;
        }
    }
}

// Global instance for easy access
export const testProcessManager = new TestProcessManager();

/**
 * Utility function to run a test command with timeout and process management
 */
export async function runTestCommand(
    id: string,
    command: string[],
    options: {
        timeout?: number;
        cwd?: string;
        env?: Record<string, string>;
        killOnTimeout?: boolean;
        memoryLimit?: number;
        isolateProcess?: boolean;
    } = {}
): Promise<{ success: boolean; output: string; error?: string }> {
    const config: ProcessConfig = {
        id,
        command,
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout || 30000,
        killOnTimeout: options.killOnTimeout !== false,
        memoryLimit: options.memoryLimit,
        isolateProcess: options.isolateProcess || false
    };

    try {
        const processInfo = await testProcessManager.startProcess(config);
        
        // Wait for process to complete or timeout
        const result = await processInfo.subprocess;
        
        const output = await result.text();
        const success = result.exitCode === 0;

        // Include memory usage information in error if OOM occurred
        let errorMessage = success ? undefined : output;
        if (processInfo.status === 'oom') {
            errorMessage = `Process exceeded memory limit (${processInfo.memoryUsage}MB/${processInfo.memoryLimit}MB)\n${output}`;
        }

        return {
            success,
            output,
            error: errorMessage
        };

    } catch (error) {
        return {
            success: false,
            output: '',
            error: error instanceof Error ? error.message : String(error)
        };
    } finally {
        // Ensure process is cleaned up
        if (testProcessManager.isProcessRunning(id)) {
            await testProcessManager.stopProcess(id);
        }
    }
}

/**
 * Utility to create a test server with automatic cleanup
 */
export async function createTestServer(
    id: string,
    command: string[],
    options: {
        port?: number;
        timeout?: number;
        healthCheckPath?: string;
        cwd?: string;
        env?: Record<string, string>;
    } = {}
): Promise<ProcessInfo> {
    const config: ProcessConfig = {
        id,
        command,
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout || 60000, // Longer timeout for servers
        killOnTimeout: true
    };

    const processInfo = await testProcessManager.startProcess(config);

    // If health check path is provided, wait for server to be ready
    if (options.healthCheckPath && options.port) {
        await waitForServerReady(options.port, options.healthCheckPath, 10000);
    }

    return processInfo;
}

/**
 * Wait for a server to be ready by checking a health endpoint
 */
async function waitForServerReady(
    port: number,
    path: string,
    timeout: number
): Promise<void> {
    const startTime = Date.now();
    const url = `http://localhost:${port}${path}`;

    while (Date.now() - startTime < timeout) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                logger.debug(`[PROCESS] Server ready at ${url}`);
                return;
            }
        } catch {
            // Server not ready yet, continue waiting
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Server at ${url} did not become ready within ${timeout}ms`);
}