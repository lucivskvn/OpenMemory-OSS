/**
 * @file Enhanced Metrics Collection System
 * Provides comprehensive performance monitoring for vector operations, database queries,
 * and system resources with Prometheus-compatible metrics.
 */

import { logger } from "./logger";

export interface VectorOperationMetrics {
    operation: 'embedding' | 'similarity' | 'search' | 'normalization';
    duration: number;
    vectorCount: number;
    dimensions: number;
    success: boolean;
    error?: string;
    timestamp: number;
}

export interface DatabaseQueryMetrics {
    query: string;
    duration: number;
    rowsAffected: number;
    success: boolean;
    error?: string;
    timestamp: number;
    queryType: 'select' | 'insert' | 'update' | 'delete' | 'other';
}

export interface SystemResourceMetrics {
    memory: {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
        arrayBuffers: number;
    };
    cpu: {
        user: number;
        system: number;
    };
    uptime: number;
    timestamp: number;
}

export interface ApiEndpointMetrics {
    endpoint: string;
    method: string;
    statusCode: number;
    duration: number;
    success: boolean;
    timestamp: number;
    userAgent?: string;
    ip?: string;
}

/**
 * Enhanced metrics collector with performance tracking and Prometheus compatibility
 */
export class MetricsCollector {
    private vectorMetrics: VectorOperationMetrics[] = [];
    private dbMetrics: DatabaseQueryMetrics[] = [];
    private systemMetrics: SystemResourceMetrics[] = [];
    private apiMetrics: ApiEndpointMetrics[] = [];
    
    private readonly MAX_METRICS_HISTORY = 1000;
    private readonly CLEANUP_INTERVAL = 60000; // 1 minute
    private cleanupTimer?: Timer;

    constructor() {
        this.startCleanupTimer();
    }

    /**
     * Record vector operation performance metrics
     */
    recordVectorOperation(metrics: Omit<VectorOperationMetrics, 'timestamp'>): void {
        const metric: VectorOperationMetrics = {
            ...metrics,
            timestamp: Date.now()
        };

        this.vectorMetrics.push(metric);
        this.trimMetrics(this.vectorMetrics);

        if (!metrics.success) {
            logger.warn(`[METRICS] Vector operation failed: ${metrics.operation}`, {
                duration: metrics.duration,
                error: metrics.error
            });
        }
    }

    /**
     * Record database query performance metrics
     */
    recordDatabaseQuery(metrics: Omit<DatabaseQueryMetrics, 'timestamp' | 'queryType'>): void {
        const queryType = this.inferQueryType(metrics.query);
        const metric: DatabaseQueryMetrics = {
            ...metrics,
            queryType,
            timestamp: Date.now()
        };

        this.dbMetrics.push(metric);
        this.trimMetrics(this.dbMetrics);

        // Log slow queries
        if (metrics.duration > 1000) { // > 1 second
            logger.warn(`[METRICS] Slow database query detected`, {
                query: metrics.query.substring(0, 100) + '...',
                duration: metrics.duration,
                rowsAffected: metrics.rowsAffected
            });
        }
    }

    /**
     * Record system resource metrics
     */
    recordSystemResources(): void {
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();

        const metric: SystemResourceMetrics = {
            memory: {
                rss: memUsage.rss,
                heapTotal: memUsage.heapTotal,
                heapUsed: memUsage.heapUsed,
                external: memUsage.external,
                arrayBuffers: memUsage.arrayBuffers || 0
            },
            cpu: cpuUsage,
            uptime: process.uptime(),
            timestamp: Date.now()
        };

        this.systemMetrics.push(metric);
        this.trimMetrics(this.systemMetrics);
    }

    /**
     * Record API endpoint performance metrics
     */
    recordApiEndpoint(metrics: Omit<ApiEndpointMetrics, 'timestamp' | 'success'>): void {
        const metric: ApiEndpointMetrics = {
            ...metrics,
            success: metrics.statusCode >= 200 && metrics.statusCode < 400,
            timestamp: Date.now()
        };

        this.apiMetrics.push(metric);
        this.trimMetrics(this.apiMetrics);
    }

    /**
     * Get vector operation performance statistics
     */
    getVectorOperationStats(timeWindow?: number): {
        totalOperations: number;
        averageDuration: number;
        successRate: number;
        operationBreakdown: Record<string, number>;
        slowestOperations: VectorOperationMetrics[];
    } {
        const cutoff = timeWindow ? Date.now() - timeWindow : 0;
        const metrics = this.vectorMetrics.filter(m => m.timestamp > cutoff);

        if (metrics.length === 0) {
            return {
                totalOperations: 0,
                averageDuration: 0,
                successRate: 0,
                operationBreakdown: {},
                slowestOperations: []
            };
        }

        const totalOperations = metrics.length;
        const averageDuration = metrics.reduce((sum, m) => sum + m.duration, 0) / totalOperations;
        const successCount = metrics.filter(m => m.success).length;
        const successRate = successCount / totalOperations;

        const operationBreakdown: Record<string, number> = {};
        metrics.forEach(m => {
            operationBreakdown[m.operation] = (operationBreakdown[m.operation] || 0) + 1;
        });

        const slowestOperations = [...metrics]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 5);

        return {
            totalOperations,
            averageDuration,
            successRate,
            operationBreakdown,
            slowestOperations
        };
    }

    /**
     * Get database query performance statistics
     */
    getDatabaseQueryStats(timeWindow?: number): {
        totalQueries: number;
        averageDuration: number;
        successRate: number;
        queryTypeBreakdown: Record<string, number>;
        slowestQueries: DatabaseQueryMetrics[];
    } {
        const cutoff = timeWindow ? Date.now() - timeWindow : 0;
        const metrics = this.dbMetrics.filter(m => m.timestamp > cutoff);

        if (metrics.length === 0) {
            return {
                totalQueries: 0,
                averageDuration: 0,
                successRate: 0,
                queryTypeBreakdown: {},
                slowestQueries: []
            };
        }

        const totalQueries = metrics.length;
        const averageDuration = metrics.reduce((sum, m) => sum + m.duration, 0) / totalQueries;
        const successCount = metrics.filter(m => m.success).length;
        const successRate = successCount / totalQueries;

        const queryTypeBreakdown: Record<string, number> = {};
        metrics.forEach(m => {
            queryTypeBreakdown[m.queryType] = (queryTypeBreakdown[m.queryType] || 0) + 1;
        });

        const slowestQueries = [...metrics]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 5);

        return {
            totalQueries,
            averageDuration,
            successRate,
            queryTypeBreakdown,
            slowestQueries
        };
    }

    /**
     * Get API endpoint performance statistics
     */
    getApiEndpointStats(timeWindow?: number): {
        totalRequests: number;
        averageDuration: number;
        successRate: number;
        endpointBreakdown: Record<string, number>;
        statusCodeBreakdown: Record<number, number>;
        slowestEndpoints: ApiEndpointMetrics[];
    } {
        const cutoff = timeWindow ? Date.now() - timeWindow : 0;
        const metrics = this.apiMetrics.filter(m => m.timestamp > cutoff);

        if (metrics.length === 0) {
            return {
                totalRequests: 0,
                averageDuration: 0,
                successRate: 0,
                endpointBreakdown: {},
                statusCodeBreakdown: {},
                slowestEndpoints: []
            };
        }

        const totalRequests = metrics.length;
        const averageDuration = metrics.reduce((sum, m) => sum + m.duration, 0) / totalRequests;
        const successCount = metrics.filter(m => m.success).length;
        const successRate = successCount / totalRequests;

        const endpointBreakdown: Record<string, number> = {};
        const statusCodeBreakdown: Record<number, number> = {};

        metrics.forEach(m => {
            const key = `${m.method} ${m.endpoint}`;
            endpointBreakdown[key] = (endpointBreakdown[key] || 0) + 1;
            statusCodeBreakdown[m.statusCode] = (statusCodeBreakdown[m.statusCode] || 0) + 1;
        });

        const slowestEndpoints = [...metrics]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 5);

        return {
            totalRequests,
            averageDuration,
            successRate,
            endpointBreakdown,
            statusCodeBreakdown,
            slowestEndpoints
        };
    }

    /**
     * Get current system resource metrics
     */
    getCurrentSystemMetrics(): SystemResourceMetrics {
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();

        return {
            memory: {
                rss: memUsage.rss,
                heapTotal: memUsage.heapTotal,
                heapUsed: memUsage.heapUsed,
                external: memUsage.external,
                arrayBuffers: memUsage.arrayBuffers || 0
            },
            cpu: cpuUsage,
            uptime: process.uptime(),
            timestamp: Date.now()
        };
    }

    /**
     * Generate Prometheus-compatible metrics format
     */
    generatePrometheusMetrics(): string {
        const lines: string[] = [];
        const now = Date.now();
        const timeWindow = 300000; // 5 minutes

        // Vector operation metrics
        const vectorStats = this.getVectorOperationStats(timeWindow);
        lines.push('# HELP openmemory_vector_operations_total Total number of vector operations');
        lines.push('# TYPE openmemory_vector_operations_total counter');
        lines.push(`openmemory_vector_operations_total ${vectorStats.totalOperations}`);

        lines.push('# HELP openmemory_vector_operation_duration_avg Average vector operation duration in milliseconds');
        lines.push('# TYPE openmemory_vector_operation_duration_avg gauge');
        lines.push(`openmemory_vector_operation_duration_avg ${vectorStats.averageDuration.toFixed(2)}`);

        lines.push('# HELP openmemory_vector_operation_success_rate Vector operation success rate');
        lines.push('# TYPE openmemory_vector_operation_success_rate gauge');
        lines.push(`openmemory_vector_operation_success_rate ${vectorStats.successRate.toFixed(4)}`);

        // Database query metrics
        const dbStats = this.getDatabaseQueryStats(timeWindow);
        lines.push('# HELP openmemory_db_queries_total Total number of database queries');
        lines.push('# TYPE openmemory_db_queries_total counter');
        lines.push(`openmemory_db_queries_total ${dbStats.totalQueries}`);

        lines.push('# HELP openmemory_db_query_duration_avg Average database query duration in milliseconds');
        lines.push('# TYPE openmemory_db_query_duration_avg gauge');
        lines.push(`openmemory_db_query_duration_avg ${dbStats.averageDuration.toFixed(2)}`);

        // System resource metrics
        const systemMetrics = this.getCurrentSystemMetrics();
        lines.push('# HELP openmemory_memory_usage_bytes Memory usage in bytes');
        lines.push('# TYPE openmemory_memory_usage_bytes gauge');
        lines.push(`openmemory_memory_usage_bytes{type="rss"} ${systemMetrics.memory.rss}`);
        lines.push(`openmemory_memory_usage_bytes{type="heap_total"} ${systemMetrics.memory.heapTotal}`);
        lines.push(`openmemory_memory_usage_bytes{type="heap_used"} ${systemMetrics.memory.heapUsed}`);

        lines.push('# HELP openmemory_uptime_seconds Process uptime in seconds');
        lines.push('# TYPE openmemory_uptime_seconds gauge');
        lines.push(`openmemory_uptime_seconds ${systemMetrics.uptime.toFixed(2)}`);

        return lines.join('\n') + '\n';
    }

    /**
     * Get comprehensive metrics summary
     */
    getMetricsSummary(timeWindow: number = 300000): {
        vector: ReturnType<typeof this.getVectorOperationStats>;
        database: ReturnType<typeof this.getDatabaseQueryStats>;
        api: ReturnType<typeof this.getApiEndpointStats>;
        system: SystemResourceMetrics;
        timestamp: number;
    } {
        return {
            vector: this.getVectorOperationStats(timeWindow),
            database: this.getDatabaseQueryStats(timeWindow),
            api: this.getApiEndpointStats(timeWindow),
            system: this.getCurrentSystemMetrics(),
            timestamp: Date.now()
        };
    }

    /**
     * Clear all metrics history
     */
    clearMetrics(): void {
        this.vectorMetrics.length = 0;
        this.dbMetrics.length = 0;
        this.systemMetrics.length = 0;
        this.apiMetrics.length = 0;
        logger.info('[METRICS] All metrics history cleared');
    }

    /**
     * Stop the metrics collector and cleanup
     */
    stop(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        logger.info('[METRICS] Metrics collector stopped');
    }

    private inferQueryType(query: string): DatabaseQueryMetrics['queryType'] {
        const normalizedQuery = query.trim().toLowerCase();
        if (normalizedQuery.startsWith('select')) return 'select';
        if (normalizedQuery.startsWith('insert')) return 'insert';
        if (normalizedQuery.startsWith('update')) return 'update';
        if (normalizedQuery.startsWith('delete')) return 'delete';
        return 'other';
    }

    private trimMetrics<T>(metrics: T[]): void {
        if (metrics.length > this.MAX_METRICS_HISTORY) {
            metrics.splice(0, metrics.length - this.MAX_METRICS_HISTORY);
        }
    }

    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
            
            this.vectorMetrics = this.vectorMetrics.filter(m => m.timestamp > cutoff);
            this.dbMetrics = this.dbMetrics.filter(m => m.timestamp > cutoff);
            this.systemMetrics = this.systemMetrics.filter(m => m.timestamp > cutoff);
            this.apiMetrics = this.apiMetrics.filter(m => m.timestamp > cutoff);
            
            logger.debug('[METRICS] Cleaned up old metrics data');
        }, this.CLEANUP_INTERVAL);
    }
}

// Export singleton instance
export const metricsCollector = new MetricsCollector();

/**
 * Decorator for timing function execution and recording metrics
 */
export function timed<T extends (...args: any[]) => any>(
    operation: string,
    category: 'vector' | 'database' | 'api'
) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            const startTime = Date.now();
            let success = true;
            let error: string | undefined;

            try {
                const result = await originalMethod.apply(this, args);
                return result;
            } catch (err) {
                success = false;
                error = err instanceof Error ? err.message : String(err);
                throw err;
            } finally {
                const duration = Date.now() - startTime;

                if (category === 'vector') {
                    metricsCollector.recordVectorOperation({
                        operation: operation as any,
                        duration,
                        vectorCount: args[0]?.length || 1,
                        dimensions: args[0]?.[0]?.length || 0,
                        success,
                        error
                    });
                } else if (category === 'database') {
                    metricsCollector.recordDatabaseQuery({
                        query: operation,
                        duration,
                        rowsAffected: 0, // Would need to be extracted from result
                        success,
                        error
                    });
                }
            }
        };

        return descriptor;
    };
}