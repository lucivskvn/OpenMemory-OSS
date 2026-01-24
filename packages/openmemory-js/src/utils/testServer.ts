/**
 * @file Test Server Utilities
 * Provides utilities for managing test servers with proper lifecycle management
 */

import { testProcessManager, createTestServer, ProcessInfo } from "./testProcessManager";
import { logger } from "./logger";

export interface TestServerConfig {
    /** Server identifier */
    id: string;
    /** Port to run the server on */
    port: number;
    /** Server command and arguments */
    command: string[];
    /** Working directory */
    cwd?: string;
    /** Environment variables */
    env?: Record<string, string>;
    /** Health check endpoint path */
    healthCheckPath?: string;
    /** Startup timeout in milliseconds */
    startupTimeout?: number;
    /** Whether to wait for health check before considering server ready */
    waitForHealthCheck?: boolean;
}

/**
 * Manages test servers with automatic cleanup and health checking
 */
export class TestServerManager {
    private servers = new Map<string, ProcessInfo>();

    /**
     * Start a test server with health checking
     */
    async startServer(config: TestServerConfig): Promise<ProcessInfo> {
        if (this.servers.has(config.id)) {
            throw new Error(`Server ${config.id} is already running`);
        }

        logger.info(`[TEST-SERVER] Starting server: ${config.id} on port ${config.port}`);

        const serverEnv = {
            PORT: config.port.toString(),
            OM_TIER: "local",
            OM_EMBEDDINGS: "local",
            OM_DB_PATH: ":memory:",
            OM_LOG_LEVEL: "error",
            OM_TELEMETRY_ENABLED: "false",
            OM_TEST_MODE: "true",
            OM_API_KEYS: "test-key-123",
            OM_ADMIN_KEY: "admin-test-key-456",
            ...config.env
        };

        try {
            const processInfo = await createTestServer(config.id, config.command, {
                port: config.port,
                timeout: config.startupTimeout || 30000,
                healthCheckPath: config.healthCheckPath,
                cwd: config.cwd,
                env: serverEnv
            });

            this.servers.set(config.id, processInfo);

            // Additional health check if specified
            if (config.waitForHealthCheck && config.healthCheckPath) {
                await this.waitForServerHealth(config.port, config.healthCheckPath, 10000);
            }

            logger.info(`[TEST-SERVER] Server ${config.id} is ready on port ${config.port}`);
            return processInfo;

        } catch (error) {
            logger.error(`[TEST-SERVER] Failed to start server ${config.id}:`, error);
            throw error;
        }
    }

    /**
     * Stop a test server
     */
    async stopServer(id: string): Promise<boolean> {
        const server = this.servers.get(id);
        if (!server) {
            logger.warn(`[TEST-SERVER] Server ${id} not found`);
            return false;
        }

        logger.info(`[TEST-SERVER] Stopping server: ${id}`);

        try {
            const success = await testProcessManager.stopProcess(id);
            if (success) {
                this.servers.delete(id);
                logger.info(`[TEST-SERVER] Server ${id} stopped successfully`);
            }
            return success;
        } catch (error) {
            logger.error(`[TEST-SERVER] Failed to stop server ${id}:`, error);
            return false;
        }
    }

    /**
     * Stop all test servers
     */
    async stopAllServers(): Promise<void> {
        if (this.servers.size === 0) {
            return;
        }

        logger.info(`[TEST-SERVER] Stopping ${this.servers.size} servers...`);

        const stopPromises = Array.from(this.servers.keys()).map(id => this.stopServer(id));
        await Promise.allSettled(stopPromises);

        this.servers.clear();
        logger.info(`[TEST-SERVER] All servers stopped`);
    }

    /**
     * Get server information
     */
    getServer(id: string): ProcessInfo | undefined {
        return this.servers.get(id);
    }

    /**
     * Check if a server is running
     */
    isServerRunning(id: string): boolean {
        const server = this.servers.get(id);
        return server?.status === 'running';
    }

    /**
     * Get the base URL for a server
     */
    getServerUrl(id: string): string | undefined {
        const server = this.servers.get(id);
        if (!server) return undefined;

        // Extract port from environment or use default
        const port = process.env.PORT || '3000';
        return `http://localhost:${port}`;
    }

    /**
     * Wait for server to respond to health checks
     */
    private async waitForServerHealth(
        port: number,
        healthPath: string,
        timeout: number
    ): Promise<void> {
        const startTime = Date.now();
        const url = `http://localhost:${port}${healthPath}`;
        let lastError: Error | undefined;

        while (Date.now() - startTime < timeout) {
            try {
                const response = await fetch(url, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });

                if (response.ok) {
                    logger.debug(`[TEST-SERVER] Health check passed: ${url}`);
                    return;
                }

                lastError = new Error(`Health check failed with status ${response.status}`);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }

            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        throw new Error(
            `Server health check failed after ${timeout}ms. Last error: ${lastError?.message}`
        );
    }

    /**
     * Make a request to a test server
     */
    async makeRequest(
        serverId: string,
        path: string,
        options: RequestInit = {}
    ): Promise<Response> {
        const baseUrl = this.getServerUrl(serverId);
        if (!baseUrl) {
            throw new Error(`Server ${serverId} is not running`);
        }

        const url = `${baseUrl}${path}`;
        return fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-key-123',
                ...options.headers
            },
            ...options
        });
    }
}

// Global instance for easy access
export const testServerManager = new TestServerManager();

/**
 * Utility function to start an OpenMemory test server
 */
export async function startOpenMemoryServer(
    port = 3000,
    options: Partial<TestServerConfig> = {}
): Promise<ProcessInfo> {
    const config: TestServerConfig = {
        id: `openmemory-server-${port}`,
        port,
        command: ['bun', 'src/server/start.ts'],
        healthCheckPath: '/health',
        startupTimeout: 30000,
        waitForHealthCheck: true,
        ...options
    };

    return testServerManager.startServer(config);
}

/**
 * Utility function to start an MCP test server
 */
export async function startMCPServer(
    port = 3001,
    options: Partial<TestServerConfig> = {}
): Promise<ProcessInfo> {
    const config: TestServerConfig = {
        id: `mcp-server-${port}`,
        port,
        command: ['bun', 'src/ai/mcp.ts'],
        healthCheckPath: '/health',
        startupTimeout: 20000,
        waitForHealthCheck: true,
        ...options
    };

    return testServerManager.startServer(config);
}

/**
 * Cleanup function to stop all test servers
 */
export async function cleanupTestServers(): Promise<void> {
    await testServerManager.stopAllServers();
}

// Set up automatic cleanup on process exit
testProcessManager.addShutdownHandler(cleanupTestServers);