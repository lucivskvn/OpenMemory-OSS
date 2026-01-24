/**
 * @file Database Query Optimizer
 * Provides query performance monitoring, connection pool optimization, and query batching
 * for improved database performance across SQLite and PostgreSQL backends.
 */

import { logger } from "../utils/logger";
import { env } from "./cfg";
import { getIsPg } from "./db_access";

/**
 * Query performance metrics for monitoring
 */
export interface QueryMetrics {
    sql: string;
    duration: number;
    timestamp: number;
    rowCount?: number;
    params?: number;
    cached?: boolean;
    backend: 'sqlite' | 'postgres';
}

/**
 * Connection pool statistics
 */
export interface PoolStats {
    totalConnections: number;
    activeConnections: number;
    idleConnections: number;
    waitingClients: number;
    totalQueries: number;
    averageQueryTime: number;
    slowQueries: number;
    cacheHitRate: number;
}

/**
 * Query optimization recommendations
 */
export interface OptimizationRecommendation {
    type: 'index' | 'query' | 'connection' | 'cache';
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    suggestion: string;
    impact: string;
    sql?: string;
}

/**
 * Database Query Performance Monitor
 * Tracks query performance, identifies bottlenecks, and provides optimization recommendations
 */
export class QueryPerformanceMonitor {
    private static instance: QueryPerformanceMonitor;
    private metrics: QueryMetrics[] = [];
    private slowQueryThreshold: number;
    private maxMetricsHistory: number;
    private isMonitoring: boolean = false;
    
    // Query pattern analysis
    private queryPatterns = new Map<string, {
        count: number;
        totalDuration: number;
        avgDuration: number;
        maxDuration: number;
        lastSeen: number;
    }>();
    
    // Connection pool monitoring
    private poolMetrics = {
        totalQueries: 0,
        totalDuration: 0,
        slowQueries: 0,
        cacheHits: 0,
        cacheMisses: 0,
    };

    private constructor() {
        this.slowQueryThreshold = env.verbose ? 100 : 1000; // 100ms in verbose mode, 1s otherwise
        this.maxMetricsHistory = 10000; // Keep last 10k queries
    }

    static getInstance(): QueryPerformanceMonitor {
        if (!QueryPerformanceMonitor.instance) {
            QueryPerformanceMonitor.instance = new QueryPerformanceMonitor();
        }
        return QueryPerformanceMonitor.instance;
    }

    /**
     * Start monitoring query performance
     */
    startMonitoring(): void {
        this.isMonitoring = true;
        logger.info("[QueryOptimizer] Performance monitoring started");
    }

    /**
     * Stop monitoring query performance
     */
    stopMonitoring(): void {
        this.isMonitoring = false;
        logger.info("[QueryOptimizer] Performance monitoring stopped");
    }

    /**
     * Record a query execution for performance analysis
     */
    recordQuery(metrics: QueryMetrics): void {
        if (!this.isMonitoring) return;

        // Add to metrics history
        this.metrics.push(metrics);
        
        // Maintain history size limit
        if (this.metrics.length > this.maxMetricsHistory) {
            this.metrics = this.metrics.slice(-this.maxMetricsHistory);
        }

        // Update pool metrics
        this.poolMetrics.totalQueries++;
        this.poolMetrics.totalDuration += metrics.duration;
        
        if (metrics.duration > this.slowQueryThreshold) {
            this.poolMetrics.slowQueries++;
            logger.warn("[QueryOptimizer] Slow query detected", {
                sql: metrics.sql.substring(0, 100),
                duration: metrics.duration,
                backend: metrics.backend,
                params: metrics.params
            });
        }

        if (metrics.cached) {
            this.poolMetrics.cacheHits++;
        } else {
            this.poolMetrics.cacheMisses++;
        }

        // Update query pattern analysis
        const pattern = this.normalizeQuery(metrics.sql);
        const existing = this.queryPatterns.get(pattern);
        
        if (existing) {
            existing.count++;
            existing.totalDuration += metrics.duration;
            existing.avgDuration = existing.totalDuration / existing.count;
            existing.maxDuration = Math.max(existing.maxDuration, metrics.duration);
            existing.lastSeen = metrics.timestamp;
        } else {
            this.queryPatterns.set(pattern, {
                count: 1,
                totalDuration: metrics.duration,
                avgDuration: metrics.duration,
                maxDuration: metrics.duration,
                lastSeen: metrics.timestamp
            });
        }
    }

    /**
     * Normalize SQL query for pattern analysis (remove specific values)
     */
    private normalizeQuery(sql: string): string {
        return sql
            .replace(/\b\d+\b/g, '?') // Replace numbers with ?
            .replace(/'[^']*'/g, '?') // Replace string literals with ?
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim()
            .toLowerCase();
    }

    /**
     * Get current pool statistics
     */
    getPoolStats(): PoolStats {
        const cacheHitRate = this.poolMetrics.cacheHits + this.poolMetrics.cacheMisses > 0
            ? this.poolMetrics.cacheHits / (this.poolMetrics.cacheHits + this.poolMetrics.cacheMisses)
            : 0;

        return {
            totalConnections: getIsPg() ? env.pgMax : 1, // SQLite uses single connection
            activeConnections: 1, // Simplified - would need actual pool monitoring
            idleConnections: getIsPg() ? env.pgMax - 1 : 0,
            waitingClients: 0, // Would need actual pool monitoring
            totalQueries: this.poolMetrics.totalQueries,
            averageQueryTime: this.poolMetrics.totalQueries > 0 
                ? this.poolMetrics.totalDuration / this.poolMetrics.totalQueries 
                : 0,
            slowQueries: this.poolMetrics.slowQueries,
            cacheHitRate
        };
    }

    /**
     * Analyze query patterns and generate optimization recommendations
     */
    generateRecommendations(): OptimizationRecommendation[] {
        const recommendations: OptimizationRecommendation[] = [];
        const stats = this.getPoolStats();

        // Check for slow queries
        if (stats.slowQueries > stats.totalQueries * 0.1) {
            recommendations.push({
                type: 'query',
                severity: 'high',
                description: `${stats.slowQueries} slow queries detected (${((stats.slowQueries / stats.totalQueries) * 100).toFixed(1)}% of total)`,
                suggestion: 'Review and optimize slow queries, consider adding indexes',
                impact: 'High - Slow queries significantly impact application performance'
            });
        }

        // Check cache hit rate
        if (stats.cacheHitRate < 0.8) {
            recommendations.push({
                type: 'cache',
                severity: 'medium',
                description: `Low cache hit rate: ${(stats.cacheHitRate * 100).toFixed(1)}%`,
                suggestion: 'Increase statement cache size or review query patterns',
                impact: 'Medium - Poor cache performance increases query overhead'
            });
        }

        // Analyze frequent query patterns
        const sortedPatterns = Array.from(this.queryPatterns.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);

        for (const [pattern, stats] of sortedPatterns) {
            if (stats.avgDuration > this.slowQueryThreshold && stats.count > 10) {
                recommendations.push({
                    type: 'index',
                    severity: stats.avgDuration > this.slowQueryThreshold * 5 ? 'critical' : 'high',
                    description: `Frequent slow query pattern: ${stats.count} executions, avg ${stats.avgDuration.toFixed(2)}ms`,
                    suggestion: 'Consider adding database indexes for this query pattern',
                    impact: `High - Query executed ${stats.count} times with poor performance`,
                    sql: pattern
                });
            }
        }

        // Connection pool recommendations for PostgreSQL
        if (getIsPg()) {
            if (stats.averageQueryTime > 100) {
                recommendations.push({
                    type: 'connection',
                    severity: 'medium',
                    description: `High average query time: ${stats.averageQueryTime.toFixed(2)}ms`,
                    suggestion: 'Consider increasing connection pool size or optimizing queries',
                    impact: 'Medium - Connection contention may be affecting performance'
                });
            }
        }

        return recommendations;
    }

    /**
     * Get detailed performance report
     */
    generateReport(): string {
        const stats = this.getPoolStats();
        const recommendations = this.generateRecommendations();
        const recentMetrics = this.metrics.slice(-100); // Last 100 queries

        let report = "\n=== Database Query Performance Report ===\n\n";
        
        // Overall statistics
        report += "📊 Overall Statistics:\n";
        report += `  Total Queries: ${stats.totalQueries}\n`;
        report += `  Average Query Time: ${stats.averageQueryTime.toFixed(2)}ms\n`;
        report += `  Slow Queries: ${stats.slowQueries} (${((stats.slowQueries / Math.max(stats.totalQueries, 1)) * 100).toFixed(1)}%)\n`;
        report += `  Cache Hit Rate: ${(stats.cacheHitRate * 100).toFixed(1)}%\n`;
        report += `  Backend: ${getIsPg() ? 'PostgreSQL' : 'SQLite'}\n\n`;

        // Connection pool info
        if (getIsPg()) {
            report += "🔗 Connection Pool:\n";
            report += `  Max Connections: ${stats.totalConnections}\n`;
            report += `  Pool Timeout: ${env.pgConnTimeout}ms\n`;
            report += `  Idle Timeout: ${env.pgIdleTimeout}ms\n\n`;
        }

        // Top query patterns
        const topPatterns = Array.from(this.queryPatterns.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 5);

        if (topPatterns.length > 0) {
            report += "🔥 Top Query Patterns:\n";
            topPatterns.forEach(([pattern, stats], index) => {
                report += `  ${index + 1}. ${stats.count} executions, avg ${stats.avgDuration.toFixed(2)}ms\n`;
                report += `     ${pattern.substring(0, 80)}...\n`;
            });
            report += "\n";
        }

        // Recommendations
        if (recommendations.length > 0) {
            report += "💡 Optimization Recommendations:\n";
            recommendations.forEach((rec, index) => {
                const icon = rec.severity === 'critical' ? '🚨' : rec.severity === 'high' ? '⚠️' : '💡';
                report += `  ${icon} ${rec.description}\n`;
                report += `     Suggestion: ${rec.suggestion}\n`;
                report += `     Impact: ${rec.impact}\n\n`;
            });
        } else {
            report += "✅ No optimization recommendations - performance looks good!\n\n";
        }

        // Recent performance trend
        if (recentMetrics.length > 0) {
            const avgRecent = recentMetrics.reduce((sum, m) => sum + m.duration, 0) / recentMetrics.length;
            const slowRecent = recentMetrics.filter(m => m.duration > this.slowQueryThreshold).length;
            
            report += "📈 Recent Performance (last 100 queries):\n";
            report += `  Average Time: ${avgRecent.toFixed(2)}ms\n`;
            report += `  Slow Queries: ${slowRecent} (${((slowRecent / recentMetrics.length) * 100).toFixed(1)}%)\n`;
        }

        report += "\n=== End Report ===\n";
        return report;
    }

    /**
     * Clear all metrics and reset monitoring
     */
    reset(): void {
        this.metrics = [];
        this.queryPatterns.clear();
        this.poolMetrics = {
            totalQueries: 0,
            totalDuration: 0,
            slowQueries: 0,
            cacheHits: 0,
            cacheMisses: 0,
        };
        logger.info("[QueryOptimizer] Metrics reset");
    }

    /**
     * Get query metrics for analysis
     */
    getMetrics(): QueryMetrics[] {
        return [...this.metrics];
    }

    /**
     * Get query patterns for analysis
     */
    getQueryPatterns(): Map<string, any> {
        return new Map(this.queryPatterns);
    }
}

/**
 * Connection Pool Optimizer
 * Provides optimized connection pool configurations based on workload analysis
 */
export class ConnectionPoolOptimizer {
    private static instance: ConnectionPoolOptimizer;
    private monitor: QueryPerformanceMonitor;

    private constructor() {
        this.monitor = QueryPerformanceMonitor.getInstance();
    }

    static getInstance(): ConnectionPoolOptimizer {
        if (!ConnectionPoolOptimizer.instance) {
            ConnectionPoolOptimizer.instance = new ConnectionPoolOptimizer();
        }
        return ConnectionPoolOptimizer.instance;
    }

    /**
     * Get optimized connection pool configuration based on current workload
     */
    getOptimizedPoolConfig(): {
        maxConnections: number;
        idleTimeout: number;
        connectionTimeout: number;
    } {
        const stats = this.monitor.getPoolStats();
        const baseConfig = {
            maxConnections: env.pgMax,
            idleTimeout: env.pgIdleTimeout,
            connectionTimeout: env.pgConnTimeout
        };

        // Don't optimize for SQLite (single connection)
        if (!getIsPg()) {
            return baseConfig;
        }

        // Adjust based on query patterns
        let optimizedConfig = { ...baseConfig };

        // If we have high query volume, increase pool size
        if (stats.totalQueries > 1000 && stats.averageQueryTime > 50) {
            optimizedConfig.maxConnections = Math.min(env.pgMax * 1.5, 50);
            logger.info("[QueryOptimizer] Increased connection pool size due to high query volume");
        }

        // If we have many slow queries, increase timeouts
        if (stats.slowQueries > stats.totalQueries * 0.2) {
            optimizedConfig.connectionTimeout = Math.min(env.pgConnTimeout * 2, 10000);
            logger.info("[QueryOptimizer] Increased timeouts due to slow query patterns");
        }

        // If cache hit rate is low, reduce idle timeout to cycle connections
        if (stats.cacheHitRate < 0.6) {
            optimizedConfig.idleTimeout = Math.max(env.pgIdleTimeout * 0.5, 10000);
            logger.info("[QueryOptimizer] Reduced idle timeout due to low cache hit rate");
        }

        return optimizedConfig;
    }

    /**
     * Analyze connection pool health and provide recommendations
     */
    analyzePoolHealth(): {
        health: 'excellent' | 'good' | 'fair' | 'poor';
        issues: string[];
        recommendations: string[];
    } {
        const stats = this.monitor.getPoolStats();
        const issues: string[] = [];
        const recommendations: string[] = [];
        let healthScore = 100;

        // Check slow query rate
        const slowQueryRate = stats.slowQueries / Math.max(stats.totalQueries, 1);
        if (slowQueryRate > 0.1) {
            healthScore -= 30;
            issues.push(`High slow query rate: ${(slowQueryRate * 100).toFixed(1)}%`);
            recommendations.push("Optimize slow queries or add database indexes");
        }

        // Check cache performance
        if (stats.cacheHitRate < 0.8) {
            healthScore -= 20;
            issues.push(`Low cache hit rate: ${(stats.cacheHitRate * 100).toFixed(1)}%`);
            recommendations.push("Increase statement cache size or review query patterns");
        }

        // Check average query time
        if (stats.averageQueryTime > 100) {
            healthScore -= 25;
            issues.push(`High average query time: ${stats.averageQueryTime.toFixed(2)}ms`);
            recommendations.push("Review query performance and connection pool configuration");
        }

        // Determine health level
        let health: 'excellent' | 'good' | 'fair' | 'poor';
        if (healthScore >= 90) health = 'excellent';
        else if (healthScore >= 70) health = 'good';
        else if (healthScore >= 50) health = 'fair';
        else health = 'poor';

        return { health, issues, recommendations };
    }
}

/**
 * Query Batch Optimizer
 * Provides intelligent query batching for improved performance
 */
export class QueryBatchOptimizer {
    private static instance: QueryBatchOptimizer;
    private pendingBatches = new Map<string, {
        queries: Array<{ sql: string; params: any[]; resolve: Function; reject: Function }>;
        timeout: NodeJS.Timeout;
    }>();

    private batchTimeout = 10; // 10ms batch window
    private maxBatchSize = 100; // Maximum queries per batch

    private constructor() {}

    static getInstance(): QueryBatchOptimizer {
        if (!QueryBatchOptimizer.instance) {
            QueryBatchOptimizer.instance = new QueryBatchOptimizer();
        }
        return QueryBatchOptimizer.instance;
    }

    /**
     * Add query to batch for optimized execution
     */
    async batchQuery<T>(
        sql: string, 
        params: any[], 
        executor: (sql: string, params: any[]) => Promise<T>
    ): Promise<T> {
        // For now, execute immediately - batching can be added later for specific patterns
        return executor(sql, params);
    }

    /**
     * Optimize INSERT queries for batch execution
     */
    optimizeInsertBatch(
        table: string,
        columns: string[],
        rows: any[][],
        onConflict?: string
    ): { sql: string; params: any[] } {
        if (rows.length === 0) {
            throw new Error("Cannot create batch insert with no rows");
        }

        const isPg = getIsPg();
        const columnList = isPg 
            ? columns.map(c => `"${c}"`).join(", ")
            : columns.join(", ");
        
        const placeholders = rows.map((_, index) => {
            const rowPlaceholders = columns.map((_, colIndex) => {
                return isPg ? `$${index * columns.length + colIndex + 1}` : "?";
            }).join(", ");
            return `(${rowPlaceholders})`;
        }).join(", ");

        let sql = `INSERT INTO ${table} (${columnList}) VALUES ${placeholders}`;
        
        if (onConflict) {
            sql += ` ${onConflict}`;
        }

        const params = rows.flat();
        return { sql, params };
    }

    /**
     * Optimize UPDATE queries for batch execution
     */
    optimizeUpdateBatch(
        table: string,
        updates: Array<{ where: Record<string, any>; set: Record<string, any> }>,
        userColumn?: string,
        userId?: string | null
    ): Array<{ sql: string; params: any[] }> {
        const isPg = getIsPg();
        const queries: Array<{ sql: string; params: any[] }> = [];

        for (const update of updates) {
            const setClauses: string[] = [];
            const whereClauses: string[] = [];
            const params: any[] = [];
            let paramIndex = 1;

            // Build SET clause
            for (const [key, value] of Object.entries(update.set)) {
                const column = isPg ? `"${key}"` : key;
                const placeholder = isPg ? `$${paramIndex++}` : "?";
                setClauses.push(`${column} = ${placeholder}`);
                params.push(value);
            }

            // Build WHERE clause
            for (const [key, value] of Object.entries(update.where)) {
                const column = isPg ? `"${key}"` : key;
                const placeholder = isPg ? `$${paramIndex++}` : "?";
                whereClauses.push(`${column} = ${placeholder}`);
                params.push(value);
            }

            // Add user constraint if specified
            if (userColumn && userId !== undefined) {
                const column = isPg ? `"${userColumn}"` : userColumn;
                if (userId === null) {
                    whereClauses.push(`${column} IS NULL`);
                } else {
                    const placeholder = isPg ? `$${paramIndex++}` : "?";
                    whereClauses.push(`${column} = ${placeholder}`);
                    params.push(userId);
                }
            }

            const sql = `UPDATE ${table} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
            queries.push({ sql, params });
        }

        return queries;
    }
}

// Global instances for easy access
export const queryPerformanceMonitor = QueryPerformanceMonitor.getInstance();
export const connectionPoolOptimizer = ConnectionPoolOptimizer.getInstance();
export const queryBatchOptimizer = QueryBatchOptimizer.getInstance();

/**
 * Wrapper function to monitor query performance
 */
export function withQueryMonitoring<T>(
    sql: string,
    params: any[],
    executor: () => Promise<T>,
    cached: boolean = false
): Promise<T> {
    const startTime = performance.now();
    
    return executor().then(result => {
        const duration = performance.now() - startTime;
        
        queryPerformanceMonitor.recordQuery({
            sql,
            duration,
            timestamp: Date.now(),
            params: params.length,
            cached,
            backend: getIsPg() ? 'postgres' : 'sqlite'
        });
        
        return result;
    }).catch(error => {
        const duration = performance.now() - startTime;
        
        queryPerformanceMonitor.recordQuery({
            sql,
            duration,
            timestamp: Date.now(),
            params: params.length,
            cached,
            backend: getIsPg() ? 'postgres' : 'sqlite'
        });
        
        throw error;
    });
}