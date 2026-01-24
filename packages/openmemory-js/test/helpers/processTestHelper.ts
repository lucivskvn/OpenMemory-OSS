/**
 * @file Process Test Helper
 * Provides high-level utilities for tests that need process management
 */

import { describe, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { testProcessManager, runTestCommand } from "../../src/utils/testProcessManager";
import { testServerManager, startOpenMemoryServer, startMCPServer } from "../../src/utils/testServer";
import { createTestSuiteTimeout, createTestTimeout, runTestWithTimeout } from "../../src/utils/testTimeout";
import { cleanupTestFiles } from "../../src/utils/testCleanup";
import { logger } from "../../src/utils/logger";
import { registerTestExecution, unregisterTestExecution, runWithWatchdog } from "../../src/utils/testWatchdog";

export interface TestSuiteConfig {
    /** Test suite name */
    name: string;
    /** Suite timeout in milliseconds */
    timeout?: number;
    /** Whether to start OpenMemory server */
    startServer?: boolean;
    /** Server port if starting server */
    serverPort?: number;
    /** Whether to start MCP server */
    startMCPServer?: boolean;
    /** MCP server port */
    mcpPort?: number;
    /** Custom setup function */
    setup?: () => Promise<void>;
    /** Custom teardown function */
    teardown?: () => Promise<void>;
}

export interface TestConfig {
    /** Test name */
    name: string;
    /** Test timeout in milliseconds */
    timeout?: number;
    /** Whether to clean up test files after test */
    cleanupFiles?: boolean;
    /** Custom setup function */
    setup?: () => Promise<void>;
    /** Custom teardown function */
    teardown?: () => Promise<void>;
}

/**
 * Creates a test suite with automatic process management
 */
export function createProcessTestSuite(
    config: TestSuiteConfig,
    suiteFn: () => void
): void {
    describe(config.name, () => {
        let suiteTimeout: ReturnType<typeof createTestSuiteTimeout> | undefined;
        let serverProcess: any;
        let mcpProcess: any;

        beforeAll(async () => {
            // Set up suite timeout
            if (config.timeout) {
                suiteTimeout = createTestSuiteTimeout(config.name, config.timeout);
            }

            logger.info(`[TEST-SUITE] Setting up: ${config.name}`);

            try {
                // Start servers if requested
                if (config.startServer) {
                    serverProcess = await startOpenMemoryServer(
                        config.serverPort || 3000,
                        { id: `${config.name}-server` }
                    );
                }

                if (config.startMCPServer) {
                    mcpProcess = await startMCPServer(
                        config.mcpPort || 3001,
                        { id: `${config.name}-mcp` }
                    );
                }

                // Run custom setup
                if (config.setup) {
                    await config.setup();
                }

                logger.info(`[TEST-SUITE] Setup complete: ${config.name}`);
            } catch (error) {
                logger.error(`[TEST-SUITE] Setup failed: ${config.name}`, error);
                throw error;
            }
        });

        afterAll(async () => {
            logger.info(`[TEST-SUITE] Tearing down: ${config.name}`);

            try {
                // Run custom teardown
                if (config.teardown) {
                    await config.teardown();
                }

                // Stop servers
                if (serverProcess) {
                    await testServerManager.stopServer(`${config.name}-server`);
                }

                if (mcpProcess) {
                    await testServerManager.stopServer(`${config.name}-mcp`);
                }

                // Stop all processes for this suite
                await testProcessManager.stopAllProcesses();

                // Clean up test files
                await cleanupTestFiles(config.name);

                logger.info(`[TEST-SUITE] Teardown complete: ${config.name}`);
            } catch (error) {
                logger.error(`[TEST-SUITE] Teardown failed: ${config.name}`, error);
            } finally {
                // Cancel suite timeout
                if (suiteTimeout) {
                    suiteTimeout.cancel();
                }
            }
        });

        // Run the test suite
        suiteFn();
    });
}

/**
 * Creates a test with automatic process management and watchdog protection
 */
export function createProcessTest(
    config: TestConfig,
    testFn: () => Promise<void>
): void {
    test(config.name, async () => {
        // Use watchdog protection for the test
        await runWithWatchdog(config.name, async () => {
            let testTimeout: ReturnType<typeof createTestTimeout> | undefined;

            try {
                // Set up test timeout
                if (config.timeout) {
                    testTimeout = createTestTimeout(config.name, config.timeout);
                }

                // Run custom setup
                if (config.setup) {
                    await config.setup();
                }

                // Run the test with timeout
                if (config.timeout) {
                    await runTestWithTimeout(config.name, testFn, config.timeout);
                } else {
                    await testFn();
                }

            } finally {
                try {
                    // Run custom teardown
                    if (config.teardown) {
                        await config.teardown();
                    }

                    // Clean up test files if requested
                    if (config.cleanupFiles) {
                        await cleanupTestFiles(config.name);
                    }
                } catch (error) {
                    logger.error(`[TEST] Teardown failed: ${config.name}`, error);
                } finally {
                    // Cancel test timeout
                    if (testTimeout) {
                        testTimeout.cancel();
                    }
                }
            }
        }, config.timeout || 30000); // Default 30 second watchdog timeout
    });
}

/**
 * Utility to run a command in a test with proper process management
 */
export async function runTestCommandSafe(
    testName: string,
    command: string[],
    options: {
        timeout?: number;
        cwd?: string;
        env?: Record<string, string>;
        expectSuccess?: boolean;
    } = {}
): Promise<{ success: boolean; output: string; error?: string }> {
    const processId = `${testName}-${Date.now()}`;
    
    try {
        const result = await runTestCommand(processId, command, {
            timeout: options.timeout || 30000,
            cwd: options.cwd,
            env: options.env,
            killOnTimeout: true
        });

        if (options.expectSuccess && !result.success) {
            throw new Error(`Command failed: ${result.error || 'Unknown error'}`);
        }

        return result;
    } catch (error) {
        logger.error(`[TEST-COMMAND] Failed to run command for ${testName}:`, error);
        throw error;
    }
}

/**
 * Utility to make HTTP requests to test servers
 */
export async function makeTestRequest(
    serverId: string,
    path: string,
    options: RequestInit = {}
): Promise<Response> {
    return testServerManager.makeRequest(serverId, path, options);
}

/**
 * Utility to wait for a condition with timeout
 */
export async function waitForCondition(
    condition: () => Promise<boolean> | boolean,
    timeout: number = 10000,
    interval: number = 500
): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
        try {
            const result = await condition();
            if (result) {
                return;
            }
        } catch (error) {
            // Ignore errors and continue waiting
        }
        
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Utility to create a test database with cleanup
 */
export async function createTestDatabase(testName: string): Promise<string> {
    const dbPath = `test_${testName}_${Date.now()}.sqlite`;
    
    // Register cleanup
    const cleanup = async () => {
        try {
            const exists = await Bun.file(dbPath).exists();
            if (exists) {
                if (process.platform === 'win32') {
                    await Bun.spawn(['del', '/F', dbPath], { stdout: 'ignore', stderr: 'ignore' });
                } else {
                    await Bun.spawn(['rm', '-f', dbPath], { stdout: 'ignore', stderr: 'ignore' });
                }
            }
        } catch (error) {
            logger.warn(`[TEST-DB] Failed to cleanup database ${dbPath}:`, error);
        }
    };

    // Register cleanup with process manager
    testProcessManager.addShutdownHandler(cleanup);
    
    return dbPath;
}

/**
 * Utility to create a test environment with all necessary setup
 */
export function createTestEnvironment(name: string): Record<string, string> {
    return {
        OM_TIER: "local",
        OM_EMBEDDINGS: "local",
        OM_DB_PATH: ":memory:",
        OM_LOG_LEVEL: "error",
        OM_TELEMETRY_ENABLED: "false",
        OM_TEST_MODE: "true",
        OM_API_KEYS: "test-key-123",
        OM_ADMIN_KEY: "admin-test-key-456",
        OM_TEST_NAME: name,
        NODE_ENV: "test"
    };
}

/**
 * Utility to check if a port is available
 */
export async function isPortAvailable(port: number): Promise<boolean> {
    try {
        const response = await fetch(`http://localhost:${port}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(1000)
        });
        return false; // Port is in use
    } catch {
        return true; // Port is available
    }
}

/**
 * Utility to find an available port starting from a base port
 */
export async function findAvailablePort(basePort: number = 3000): Promise<number> {
    let port = basePort;
    while (port < basePort + 100) { // Check up to 100 ports
        if (await isPortAvailable(port)) {
            return port;
        }
        port++;
    }
    throw new Error(`No available port found starting from ${basePort}`);
}