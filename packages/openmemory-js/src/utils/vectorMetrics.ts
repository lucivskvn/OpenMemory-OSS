/**
 * @file Vector Operations Performance Tracking
 * Utilities for instrumenting vector operations with performance metrics
 */

import { metricsCollector } from "./metricsCollector";
import { logger } from "./logger";

/**
 * Wrapper function to time and track vector operations
 */
export async function trackVectorOperation<T>(
    operation: 'embedding' | 'similarity' | 'search' | 'normalization',
    vectorCount: number,
    dimensions: number,
    fn: () => Promise<T>
): Promise<T> {
    const startTime = Date.now();
    let success = true;
    let error: string | undefined;

    try {
        const result = await fn();
        return result;
    } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
        throw err;
    } finally {
        const duration = Date.now() - startTime;
        
        metricsCollector.recordVectorOperation({
            operation,
            duration,
            vectorCount,
            dimensions,
            success,
            error
        });

        if (duration > 1000) { // Log operations taking > 1 second
            logger.info(`[VECTOR-METRICS] ${operation} operation completed`, {
                duration,
                vectorCount,
                dimensions,
                success
            });
        }
    }
}

/**
 * Wrapper function to time and track database queries
 */
export async function trackDatabaseQuery<T>(
    query: string,
    fn: () => Promise<T>
): Promise<T> {
    const startTime = Date.now();
    let success = true;
    let error: string | undefined;
    let rowsAffected = 0;

    try {
        const result = await fn();
        
        // Try to extract rows affected from result
        if (result && typeof result === 'object') {
            if ('changes' in result) {
                rowsAffected = (result as any).changes;
            } else if ('rowCount' in result) {
                rowsAffected = (result as any).rowCount;
            } else if (Array.isArray(result)) {
                rowsAffected = result.length;
            }
        }
        
        return result;
    } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
        throw err;
    } finally {
        const duration = Date.now() - startTime;
        
        metricsCollector.recordDatabaseQuery({
            query: query.length > 200 ? query.substring(0, 200) + '...' : query,
            duration,
            rowsAffected,
            success,
            error
        });
    }
}

/**
 * Decorator for automatically tracking vector operations
 */
export function VectorOperation(
    operation: 'embedding' | 'similarity' | 'search' | 'normalization'
) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            // Try to infer vector count and dimensions from arguments
            let vectorCount = 1;
            let dimensions = 0;

            if (args.length > 0) {
                const firstArg = args[0];
                if (Array.isArray(firstArg)) {
                    vectorCount = firstArg.length;
                    if (firstArg.length > 0 && Array.isArray(firstArg[0])) {
                        dimensions = firstArg[0].length;
                    }
                } else if (typeof firstArg === 'object' && firstArg !== null) {
                    // Handle objects with vector properties
                    if ('vectors' in firstArg && Array.isArray(firstArg.vectors)) {
                        vectorCount = firstArg.vectors.length;
                        if (firstArg.vectors.length > 0 && Array.isArray(firstArg.vectors[0])) {
                            dimensions = firstArg.vectors[0].length;
                        }
                    }
                }
            }

            return trackVectorOperation(
                operation,
                vectorCount,
                dimensions,
                () => originalMethod.apply(this, args)
            );
        };

        return descriptor;
    };
}

/**
 * Decorator for automatically tracking database queries
 */
export function DatabaseQuery(queryName?: string) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            const query = queryName || propertyKey || 'unknown_query';
            
            return trackDatabaseQuery(
                query,
                () => originalMethod.apply(this, args)
            );
        };

        return descriptor;
    };
}

/**
 * Utility to create performance benchmarks for vector operations
 */
export class VectorPerformanceBenchmark {
    private results: Array<{
        operation: string;
        vectorCount: number;
        dimensions: number;
        duration: number;
        timestamp: number;
    }> = [];

    async benchmark(
        name: string,
        operation: () => Promise<void>,
        vectorCount: number,
        dimensions: number,
        iterations: number = 1
    ): Promise<{
        averageDuration: number;
        minDuration: number;
        maxDuration: number;
        totalDuration: number;
    }> {
        const durations: number[] = [];

        for (let i = 0; i < iterations; i++) {
            const startTime = Date.now();
            await operation();
            const duration = Date.now() - startTime;
            durations.push(duration);

            this.results.push({
                operation: name,
                vectorCount,
                dimensions,
                duration,
                timestamp: Date.now()
            });
        }

        const totalDuration = durations.reduce((sum, d) => sum + d, 0);
        const averageDuration = totalDuration / iterations;
        const minDuration = Math.min(...durations);
        const maxDuration = Math.max(...durations);

        logger.info(`[VECTOR-BENCHMARK] ${name} completed`, {
            iterations,
            vectorCount,
            dimensions,
            averageDuration: Math.round(averageDuration * 100) / 100,
            minDuration,
            maxDuration,
            totalDuration
        });

        return {
            averageDuration,
            minDuration,
            maxDuration,
            totalDuration
        };
    }

    getResults(): typeof this.results {
        return [...this.results];
    }

    clearResults(): void {
        this.results.length = 0;
    }
}

/**
 * Global benchmark instance
 */
export const vectorBenchmark = new VectorPerformanceBenchmark();