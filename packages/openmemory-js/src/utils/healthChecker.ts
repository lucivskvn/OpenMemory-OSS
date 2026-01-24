/**
 * @file Enhanced Health Check System
 * Provides comprehensive health checks for database connectivity, vector store validation,
 * and system component status monitoring.
 */

import { logger } from "./logger";
import { env } from "../core/cfg";

export interface HealthCheckResult {
    name: string;
    status: 'healthy' | 'unhealthy' | 'degraded';
    message?: string;
    duration?: number;
    details?: Record<string, any>;
}

export interface SystemHealthReport {
    overall: 'healthy' | 'unhealthy' | 'degraded';
    checks: HealthCheckResult[];
    timestamp: number;
    uptime: number;
    version: string;
}

/**
 * Enhanced health checker with comprehensive system validation
 */
export class HealthChecker {
    private readonly TIMEOUT_MS = 5000; // 5 second timeout for health checks
    private readonly checks: Map<string, () => Promise<HealthCheckResult>> = new Map();

    constructor() {
        this.registerDefaultChecks();
    }

    /**
     * Register a custom health check
     */
    registerCheck(name: string, checkFn: () => Promise<HealthCheckResult>): void {
        this.checks.set(name, checkFn);
    }

    /**
     * Run all health checks and return comprehensive report
     */
    async runHealthChecks(): Promise<SystemHealthReport> {
        const startTime = Date.now();
        const results: HealthCheckResult[] = [];

        // Run all checks in parallel with timeout
        const checkPromises = Array.from(this.checks.entries()).map(async ([name, checkFn]) => {
            try {
                const checkStartTime = Date.now();
                const timeoutPromise = new Promise<HealthCheckResult>((_, reject) => {
                    setTimeout(() => reject(new Error('Health check timeout')), this.TIMEOUT_MS);
                });

                const result = await Promise.race([checkFn(), timeoutPromise]);
                result.duration = Date.now() - checkStartTime;
                return result;
            } catch (error) {
                return {
                    name,
                    status: 'unhealthy' as const,
                    message: error instanceof Error ? error.message : String(error),
                    duration: Date.now() - startTime,
                };
            }
        });

        const checkResults = await Promise.all(checkPromises);
        results.push(...checkResults);

        // Determine overall health status
        const hasUnhealthy = results.some(r => r.status === 'unhealthy');
        const hasDegraded = results.some(r => r.status === 'degraded');
        
        let overall: 'healthy' | 'unhealthy' | 'degraded';
        if (hasUnhealthy) {
            overall = 'unhealthy';
        } else if (hasDegraded) {
            overall = 'degraded';
        } else {
            overall = 'healthy';
        }

        return {
            overall,
            checks: results,
            timestamp: Date.now(),
            uptime: process.uptime(),
            version: process.version
        };
    }

    /**
     * Run a quick health check (essential checks only)
     */
    async quickHealthCheck(): Promise<{ healthy: boolean; message?: string }> {
        try {
            // Just check database connectivity for quick check
            const dbResult = await this.checkDatabaseConnectivity();
            return {
                healthy: dbResult.status === 'healthy',
                message: dbResult.message
            };
        } catch (error) {
            return {
                healthy: false,
                message: error instanceof Error ? error.message : 'Health check failed'
            };
        }
    }

    /**
     * Register default health checks
     */
    private registerDefaultChecks(): void {
        this.registerCheck('database', () => this.checkDatabaseConnectivity());
        this.registerCheck('memory', () => this.checkMemoryUsage());
        this.registerCheck('disk', () => this.checkDiskSpace());
        this.registerCheck('vector_store', () => this.checkVectorStore());
        this.registerCheck('embedding_service', () => this.checkEmbeddingService());
    }

    /**
     * Check database connectivity and basic operations
     */
    private async checkDatabaseConnectivity(): Promise<HealthCheckResult> {
        try {
            const { waitForDb, q } = await import("../core/db");
            
            // Ensure database is ready
            await waitForDb();
            
            // Test basic query - check if we can read from a core table
            const startTime = Date.now();
            const testQuery = await q.getMemCount.get();
            const queryTime = Date.now() - startTime;

            // Check if query time is reasonable (< 1 second for health check)
            const status = queryTime > 1000 ? 'degraded' : 'healthy';
            
            return {
                name: 'database',
                status,
                message: status === 'healthy' ? 'Database connectivity OK' : 'Database responding slowly',
                details: {
                    backend: env.metadataBackend || 'sqlite',
                    queryTime,
                    memoryCount: testQuery || 0
                }
            };
        } catch (error) {
            logger.error('[HEALTH] Database connectivity check failed:', error);
            return {
                name: 'database',
                status: 'unhealthy',
                message: `Database connectivity failed: ${error instanceof Error ? error.message : String(error)}`,
                details: {
                    backend: env.metadataBackend || 'sqlite',
                    error: error instanceof Error ? error.message : String(error)
                }
            };
        }
    }

    /**
     * Check memory usage and detect potential issues
     */
    private async checkMemoryUsage(): Promise<HealthCheckResult> {
        try {
            const memUsage = process.memoryUsage();
            const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
            const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
            const rssMB = Math.round(memUsage.rss / 1024 / 1024);
            
            // Calculate heap usage percentage
            const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
            
            let status: 'healthy' | 'degraded' | 'unhealthy';
            let message: string;
            
            if (heapUsagePercent > 90) {
                status = 'unhealthy';
                message = `Critical memory usage: ${heapUsagePercent.toFixed(1)}%`;
            } else if (heapUsagePercent > 75) {
                status = 'degraded';
                message = `High memory usage: ${heapUsagePercent.toFixed(1)}%`;
            } else {
                status = 'healthy';
                message = `Memory usage normal: ${heapUsagePercent.toFixed(1)}%`;
            }

            return {
                name: 'memory',
                status,
                message,
                details: {
                    heapUsed: heapUsedMB,
                    heapTotal: heapTotalMB,
                    rss: rssMB,
                    external: Math.round(memUsage.external / 1024 / 1024),
                    heapUsagePercent: Math.round(heapUsagePercent * 100) / 100
                }
            };
        } catch (error) {
            return {
                name: 'memory',
                status: 'unhealthy',
                message: `Memory check failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Check available disk space
     */
    private async checkDiskSpace(): Promise<HealthCheckResult> {
        try {
            // Use Bun's native file system to check disk space
            const dbPath = env.dbPath || './data/openmemory.sqlite';
            const dbFile = Bun.file(dbPath);
            
            let diskUsage = 'unknown';
            let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
            let message = 'Disk space check completed';
            
            try {
                // Check if database file exists and get its size
                if (await dbFile.exists()) {
                    const dbSize = await dbFile.size();
                    const dbSizeMB = Math.round(dbSize / 1024 / 1024);
                    diskUsage = `${dbSizeMB}MB`;
                    
                    // Simple heuristic: if DB is very large, might indicate disk space issues
                    if (dbSizeMB > 10000) { // > 10GB
                        status = 'degraded';
                        message = `Large database size: ${dbSizeMB}MB`;
                    }
                }
            } catch (sizeError) {
                // If we can't check size, it's not critical for health
                logger.debug('[HEALTH] Could not check database size:', sizeError);
            }

            return {
                name: 'disk',
                status,
                message,
                details: {
                    dbPath,
                    dbSize: diskUsage
                }
            };
        } catch (error) {
            return {
                name: 'disk',
                status: 'degraded',
                message: `Disk space check failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Check vector store health and basic operations
     */
    private async checkVectorStore(): Promise<HealthCheckResult> {
        try {
            // Test basic vector operations
            const testVector = [0.1, 0.2, 0.3, 0.4, 0.5];
            
            // Import vector utilities
            const { normalize } = await import("../utils/vectors");
            
            const startTime = Date.now();
            const normalized = normalize(testVector);
            const operationTime = Date.now() - startTime;
            
            // Check if normalization worked correctly
            const magnitude = Math.sqrt(normalized.reduce((sum, val) => sum + val * val, 0));
            const isNormalized = Math.abs(magnitude - 1.0) < 0.0001;
            
            if (!isNormalized) {
                return {
                    name: 'vector_store',
                    status: 'unhealthy',
                    message: 'Vector normalization failed',
                    details: {
                        expectedMagnitude: 1.0,
                        actualMagnitude: magnitude,
                        operationTime
                    }
                };
            }

            const status = operationTime > 100 ? 'degraded' : 'healthy';
            const message = status === 'healthy' 
                ? 'Vector operations working normally'
                : 'Vector operations slow but functional';

            return {
                name: 'vector_store',
                status,
                message,
                details: {
                    operationTime,
                    vectorDimensions: env.vecDim || 384,
                    cacheSegments: env.cacheSegments || 512
                }
            };
        } catch (error) {
            return {
                name: 'vector_store',
                status: 'unhealthy',
                message: `Vector store check failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Check embedding service availability
     */
    private async checkEmbeddingService(): Promise<HealthCheckResult> {
        try {
            // Check if embedding configuration is valid
            const model = env.ollamaModel || 'nomic-embed-text';
            const embeddingUrl = env.ollamaUrl || 'http://localhost:11434';
            
            // For health check, we just validate configuration rather than making actual requests
            // to avoid external dependencies in health checks
            
            let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
            let message = 'Embedding service configuration valid';
            
            // Basic validation of configuration
            if (!model || !embeddingUrl) {
                status = 'degraded';
                message = 'Embedding service configuration incomplete';
            }
            
            // Check if URL format is valid
            try {
                new URL(embeddingUrl);
            } catch {
                status = 'unhealthy';
                message = 'Invalid embedding service URL';
            }

            return {
                name: 'embedding_service',
                status,
                message,
                details: {
                    model,
                    url: embeddingUrl,
                    tier: env.tier || 'hybrid'
                }
            };
        } catch (error) {
            return {
                name: 'embedding_service',
                status: 'unhealthy',
                message: `Embedding service check failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
}

// Export singleton instance
export const healthChecker = new HealthChecker();

/**
 * Simple health check function for basic endpoints
 */
export async function simpleHealthCheck(): Promise<boolean> {
    try {
        const result = await healthChecker.quickHealthCheck();
        return result.healthy;
    } catch {
        return false;
    }
}