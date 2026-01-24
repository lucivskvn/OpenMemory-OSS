/**
 * @file Vector Performance Monitoring and Benchmarking
 * Provides utilities for monitoring and optimizing vector operations performance
 */

import { logger } from "./logger";
import { 
    benchmarkVectorOperations, 
    VectorOperationStats,
    cosineSimilarityOptimized,
    normalizeOptimized,
    aggregateVectorsOptimized,
    matrixVectorMultiplyOptimized,
    vectorAddOptimized,
    vectorSubtractOptimized,
    vectorScaleOptimized
} from "./vectorsOptimized";
import { 
    cosineSimilarity as cosineSimilarityOriginal,
    normalize as normalizeOriginal,
    aggregateVectors as aggregateVectorsOriginal
} from "./vectors";

export interface PerformanceMetrics {
    operationType: string;
    optimizedTime: number;
    originalTime: number;
    speedupRatio: number;
    vectorSize: number;
    numVectors: number;
    timestamp: number;
}

export interface BenchmarkResult {
    vectorSize: number;
    numVectors: number;
    normalizeSpeedup: number;
    similaritySpeedup: number;
    aggregateSpeedup: number;
    matrixMultiplySpeedup: number;
    vectorArithmeticSpeedup: number;
    overallSpeedup: number;
    timestamp: number;
}

/**
 * Performance monitoring class for vector operations
 */
export class VectorPerformanceMonitor {
    private static instance: VectorPerformanceMonitor;
    private metrics: PerformanceMetrics[] = [];
    private benchmarkResults: BenchmarkResult[] = [];
    private isMonitoring = false;

    static getInstance(): VectorPerformanceMonitor {
        if (!VectorPerformanceMonitor.instance) {
            VectorPerformanceMonitor.instance = new VectorPerformanceMonitor();
        }
        return VectorPerformanceMonitor.instance;
    }

    /**
     * Start performance monitoring
     */
    startMonitoring(): void {
        this.isMonitoring = true;
        logger.info("[VECTOR_PERF] Performance monitoring started");
    }

    /**
     * Stop performance monitoring
     */
    stopMonitoring(): void {
        this.isMonitoring = false;
        logger.info("[VECTOR_PERF] Performance monitoring stopped");
    }

    /**
     * Record a performance metric
     */
    recordMetric(metric: PerformanceMetrics): void {
        if (!this.isMonitoring) return;
        
        this.metrics.push(metric);
        
        // Keep only last 1000 metrics to prevent memory bloat
        if (this.metrics.length > 1000) {
            this.metrics = this.metrics.slice(-1000);
        }
    }

    /**
     * Get current performance statistics
     */
    getStats(): {
        totalOperations: number;
        averageSpeedup: number;
        operationBreakdown: Record<string, { count: number; avgSpeedup: number }>;
        recentMetrics: PerformanceMetrics[];
    } {
        const breakdown: Record<string, { count: number; totalSpeedup: number }> = {};
        let totalSpeedup = 0;

        for (const metric of this.metrics) {
            if (!breakdown[metric.operationType]) {
                breakdown[metric.operationType] = { count: 0, totalSpeedup: 0 };
            }
            breakdown[metric.operationType].count++;
            breakdown[metric.operationType].totalSpeedup += metric.speedupRatio;
            totalSpeedup += metric.speedupRatio;
        }

        const operationBreakdown: Record<string, { count: number; avgSpeedup: number }> = {};
        for (const [op, data] of Object.entries(breakdown)) {
            operationBreakdown[op] = {
                count: data.count,
                avgSpeedup: data.totalSpeedup / data.count
            };
        }

        return {
            totalOperations: this.metrics.length,
            averageSpeedup: this.metrics.length > 0 ? totalSpeedup / this.metrics.length : 0,
            operationBreakdown,
            recentMetrics: this.metrics.slice(-10) // Last 10 metrics
        };
    }

    /**
     * Run comprehensive benchmark comparing optimized vs original implementations
     */
    async runBenchmark(
        vectorSizes: number[] = [128, 384, 768, 1536],
        numVectorsList: number[] = [100, 500, 1000]
    ): Promise<BenchmarkResult[]> {
        logger.info("[VECTOR_PERF] Starting comprehensive vector operations benchmark");
        
        const results: BenchmarkResult[] = [];

        for (const vectorSize of vectorSizes) {
            for (const numVectors of numVectorsList) {
                logger.debug(`[VECTOR_PERF] Benchmarking ${vectorSize}D vectors, ${numVectors} count`);
                
                const result = await this.benchmarkConfiguration(vectorSize, numVectors);
                results.push(result);
                this.benchmarkResults.push(result);
            }
        }

        // Log summary
        const avgSpeedup = results.reduce((sum, r) => sum + r.overallSpeedup, 0) / results.length;
        logger.info(`[VECTOR_PERF] Benchmark completed. Average speedup: ${avgSpeedup.toFixed(2)}x`);

        return results;
    }

    /**
     * Benchmark a specific configuration
     */
    private async benchmarkConfiguration(vectorSize: number, numVectors: number): Promise<BenchmarkResult> {
        // Generate test data
        const testVectors: number[][] = [];
        for (let i = 0; i < numVectors; i++) {
            const vector = new Array(vectorSize);
            for (let j = 0; j < vectorSize; j++) {
                vector[j] = Math.random() * 2 - 1;
            }
            testVectors.push(vector);
        }

        const queryVector = testVectors[0];
        const compareVector = testVectors[1];

        // Generate test matrix
        const testMatrix: number[][] = [];
        for (let i = 0; i < Math.min(50, vectorSize); i++) {
            const row = new Array(vectorSize);
            for (let j = 0; j < vectorSize; j++) {
                row[j] = Math.random() * 2 - 1;
            }
            testMatrix.push(row);
        }

        // Benchmark normalization
        const normalizeSpeedup = await this.benchmarkOperation(
            "normalize",
            () => normalizeOriginal(queryVector),
            () => normalizeOptimized(queryVector),
            100 // iterations
        );

        // Benchmark cosine similarity
        const similaritySpeedup = await this.benchmarkOperation(
            "cosineSimilarity", 
            () => cosineSimilarityOriginal(queryVector, compareVector),
            () => cosineSimilarityOptimized(queryVector, compareVector),
            1000 // iterations
        );

        // Benchmark aggregation (use subset for performance)
        const aggregateVectors = testVectors.slice(0, Math.min(100, numVectors));
        const aggregateSpeedup = await this.benchmarkOperation(
            "aggregateVectors",
            () => aggregateVectorsOriginal(aggregateVectors),
            () => aggregateVectorsOptimized(aggregateVectors),
            10 // iterations
        );

        // Benchmark matrix multiplication
        const matrixMultiplySpeedup = await this.benchmarkOperation(
            "matrixMultiply",
            () => {
                // Simple baseline matrix multiplication
                const result = new Array(testMatrix.length);
                for (let i = 0; i < testMatrix.length; i++) {
                    let sum = 0;
                    for (let j = 0; j < queryVector.length; j++) {
                        sum += testMatrix[i][j] * queryVector[j];
                    }
                    result[i] = sum;
                }
                return result;
            },
            () => matrixVectorMultiplyOptimized(testMatrix, queryVector),
            20 // iterations
        );

        // Benchmark vector arithmetic
        const vectorArithmeticSpeedup = await this.benchmarkOperation(
            "vectorArithmetic",
            () => {
                // Baseline vector operations
                const add = new Array(queryVector.length);
                const sub = new Array(queryVector.length);
                const scale = new Array(queryVector.length);
                for (let i = 0; i < queryVector.length; i++) {
                    add[i] = queryVector[i] + compareVector[i];
                    sub[i] = queryVector[i] - compareVector[i];
                    scale[i] = queryVector[i] * 0.5;
                }
                return { add, sub, scale };
            },
            () => {
                const add = vectorAddOptimized(queryVector, compareVector);
                const sub = vectorSubtractOptimized(queryVector, compareVector);
                const scale = vectorScaleOptimized(queryVector, 0.5);
                return { add, sub, scale };
            },
            50 // iterations
        );

        const overallSpeedup = (normalizeSpeedup + similaritySpeedup + aggregateSpeedup + 
                              matrixMultiplySpeedup + vectorArithmeticSpeedup) / 5;

        return {
            vectorSize,
            numVectors,
            normalizeSpeedup,
            similaritySpeedup,
            aggregateSpeedup,
            matrixMultiplySpeedup,
            vectorArithmeticSpeedup,
            overallSpeedup,
            timestamp: Date.now()
        };
    }

    /**
     * Benchmark a specific operation
     */
    private async benchmarkOperation(
        operationType: string,
        originalFn: () => any,
        optimizedFn: () => any,
        iterations: number
    ): Promise<number> {
        // Warmup
        for (let i = 0; i < 10; i++) {
            originalFn();
            optimizedFn();
        }

        // Benchmark original
        const originalStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            originalFn();
        }
        const originalTime = performance.now() - originalStart;

        // Benchmark optimized
        const optimizedStart = performance.now();
        for (let i = 0; i < iterations; i++) {
            optimizedFn();
        }
        const optimizedTime = performance.now() - optimizedStart;

        const speedupRatio = originalTime / optimizedTime;

        // Record metric
        this.recordMetric({
            operationType,
            originalTime,
            optimizedTime,
            speedupRatio,
            vectorSize: 0, // Will be set by caller
            numVectors: 0, // Will be set by caller
            timestamp: Date.now()
        });

        return speedupRatio;
    }

    /**
     * Get benchmark history
     */
    getBenchmarkHistory(): BenchmarkResult[] {
        return [...this.benchmarkResults];
    }

    /**
     * Clear all metrics and benchmarks
     */
    clear(): void {
        this.metrics = [];
        this.benchmarkResults = [];
        VectorOperationStats.getInstance().reset();
    }

    /**
     * Generate performance report
     */
    generateReport(): string {
        const stats = this.getStats();
        const vectorStats = VectorOperationStats.getInstance().getStats();
        
        let report = "=== Vector Operations Performance Report ===\n\n";
        
        report += `Total Operations: ${stats.totalOperations}\n`;
        report += `Average Speedup: ${stats.averageSpeedup.toFixed(2)}x\n\n`;
        
        report += "Operation Breakdown:\n";
        for (const [op, data] of Object.entries(stats.operationBreakdown)) {
            report += `  ${op}: ${data.count} ops, ${data.avgSpeedup.toFixed(2)}x speedup\n`;
        }
        
        report += "\nVector Operation Stats:\n";
        report += `  Normalizations: ${vectorStats.normalizations}\n`;
        report += `  Similarities: ${vectorStats.similarities}\n`;
        report += `  Aggregations: ${vectorStats.aggregations}\n`;
        report += `  Batch Operations: ${vectorStats.batchOperations}\n`;
        report += `  Matrix Operations: ${vectorStats.matrixOperations}\n`;
        report += `  Arithmetic Operations: ${vectorStats.arithmeticOperations}\n`;
        report += `  Total Time: ${vectorStats.totalTime.toFixed(2)}ms\n`;
        
        if (this.benchmarkResults.length > 0) {
            report += "\nRecent Benchmark Results:\n";
            const recent = this.benchmarkResults.slice(-5);
            for (const result of recent) {
                report += `  ${result.vectorSize}D x${result.numVectors}:\n`;
                report += `    Overall: ${result.overallSpeedup.toFixed(2)}x speedup\n`;
                report += `    Normalize: ${result.normalizeSpeedup.toFixed(2)}x\n`;
                report += `    Similarity: ${result.similaritySpeedup.toFixed(2)}x\n`;
                report += `    Aggregate: ${result.aggregateSpeedup.toFixed(2)}x\n`;
                report += `    Matrix Multiply: ${result.matrixMultiplySpeedup.toFixed(2)}x\n`;
                report += `    Vector Arithmetic: ${result.vectorArithmeticSpeedup.toFixed(2)}x\n`;
            }
        }
        
        return report;
    }
}

/**
 * Global performance monitor instance
 */
export const vectorPerformanceMonitor = VectorPerformanceMonitor.getInstance();

/**
 * Utility function to run performance benchmark
 */
export async function runVectorPerformanceBenchmark(): Promise<BenchmarkResult[]> {
    return await vectorPerformanceMonitor.runBenchmark();
}

/**
 * Utility function to get performance stats
 */
export function getVectorPerformanceStats() {
    return vectorPerformanceMonitor.getStats();
}