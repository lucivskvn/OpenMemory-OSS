/**
 * @file SIMD Vector Optimization Performance Tests
 * Comprehensive benchmarks for enhanced vector operations with SIMD-like optimizations
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { 
    normalizeOptimized,
    cosineSimilarityOptimized,
    aggregateVectorsOptimized,
    matrixVectorMultiplyOptimized,
    vectorAddOptimized,
    vectorSubtractOptimized,
    vectorScaleOptimized,
    benchmarkVectorOperations,
    VectorOperationStats
} from "../../src/utils/vectorsOptimized";
import { 
    normalize as normalizeOriginal,
    cosineSimilarity as cosineSimilarityOriginal,
    aggregateVectors as aggregateVectorsOriginal
} from "../../src/utils/vectors";
import { vectorPerformanceMonitor } from "../../src/utils/vectorPerformance";
import { runWithWatchdog } from "../../src/utils/testWatchdog";

describe("SIMD Vector Optimization Performance Tests", () => {
    const VECTOR_SIZES = [128, 384, 768, 1536]; // Common embedding dimensions
    const NUM_VECTORS = [100, 500, 1000];
    const PERFORMANCE_THRESHOLD = 1.2; // Minimum 20% improvement expected

    beforeAll(async () => {
        vectorPerformanceMonitor.startMonitoring();
        VectorOperationStats.getInstance().reset();
    });

    afterAll(async () => {
        vectorPerformanceMonitor.stopMonitoring();
        
        // Generate and log performance report
        const report = vectorPerformanceMonitor.generateReport();
        console.log("\n" + report);
    });

    test("Enhanced normalization should outperform original implementation", async () => {
        await runWithWatchdog("SIMD normalization performance test", async () => {
            const vectorSize = 1536;
            const iterations = 1000;
            
            // Generate test vectors
            const testVectors: number[][] = [];
            for (let i = 0; i < iterations; i++) {
                const vec = new Array(vectorSize);
                for (let j = 0; j < vectorSize; j++) {
                    vec[j] = Math.random() * 2 - 1;
                }
                testVectors.push(vec);
            }

            // Benchmark original implementation
            const originalStart = performance.now();
            for (const vec of testVectors) {
                normalizeOriginal(vec);
            }
            const originalTime = performance.now() - originalStart;

            // Benchmark optimized implementation
            const optimizedStart = performance.now();
            for (const vec of testVectors) {
                normalizeOptimized(vec);
            }
            const optimizedTime = performance.now() - optimizedStart;

            const speedup = originalTime / optimizedTime;
            console.log(`Normalization speedup: ${speedup.toFixed(2)}x (${originalTime.toFixed(2)}ms -> ${optimizedTime.toFixed(2)}ms)`);

            expect(speedup).toBeGreaterThan(PERFORMANCE_THRESHOLD);
        });
    });

    test("Enhanced cosine similarity should outperform original implementation", async () => {
        await runWithWatchdog("SIMD cosine similarity performance test", async () => {
            const vectorSize = 1536;
            const iterations = 1000;
            
            // Generate test vectors
            const vecA = new Array(vectorSize);
            const vecB = new Array(vectorSize);
            for (let i = 0; i < vectorSize; i++) {
                vecA[i] = Math.random() * 2 - 1;
                vecB[i] = Math.random() * 2 - 1;
            }

            // Benchmark original implementation
            const originalStart = performance.now();
            for (let i = 0; i < iterations; i++) {
                cosineSimilarityOriginal(vecA, vecB);
            }
            const originalTime = performance.now() - originalStart;

            // Benchmark optimized implementation
            const optimizedStart = performance.now();
            for (let i = 0; i < iterations; i++) {
                cosineSimilarityOptimized(vecA, vecB);
            }
            const optimizedTime = performance.now() - optimizedStart;

            const speedup = originalTime / optimizedTime;
            console.log(`Cosine similarity speedup: ${speedup.toFixed(2)}x (${originalTime.toFixed(2)}ms -> ${optimizedTime.toFixed(2)}ms)`);

            expect(speedup).toBeGreaterThan(PERFORMANCE_THRESHOLD);
        });
    });

    test("Enhanced vector aggregation should outperform original implementation", async () => {
        await runWithWatchdog("SIMD vector aggregation performance test", async () => {
            const vectorSize = 768;
            const numVectors = 100;
            const iterations = 50;
            
            // Generate test vectors
            const testVectors: number[][] = [];
            for (let i = 0; i < numVectors; i++) {
                const vec = new Array(vectorSize);
                for (let j = 0; j < vectorSize; j++) {
                    vec[j] = Math.random() * 2 - 1;
                }
                testVectors.push(vec);
            }

            // Benchmark original implementation
            const originalStart = performance.now();
            for (let i = 0; i < iterations; i++) {
                aggregateVectorsOriginal(testVectors);
            }
            const originalTime = performance.now() - originalStart;

            // Benchmark optimized implementation
            const optimizedStart = performance.now();
            for (let i = 0; i < iterations; i++) {
                aggregateVectorsOptimized(testVectors);
            }
            const optimizedTime = performance.now() - optimizedStart;

            const speedup = originalTime / optimizedTime;
            console.log(`Vector aggregation speedup: ${speedup.toFixed(2)}x (${originalTime.toFixed(2)}ms -> ${optimizedTime.toFixed(2)}ms)`);

            expect(speedup).toBeGreaterThan(PERFORMANCE_THRESHOLD);
        });
    });

    test("Matrix-vector multiplication should be efficient", async () => {
        await runWithWatchdog("SIMD matrix-vector multiplication test", async () => {
            const vectorSize = 1536;
            const matrixRows = 100;
            const iterations = 20;
            
            // Generate test matrix and vector
            const matrix: number[][] = [];
            for (let i = 0; i < matrixRows; i++) {
                const row = new Array(vectorSize);
                for (let j = 0; j < vectorSize; j++) {
                    row[j] = Math.random() * 2 - 1;
                }
                matrix.push(row);
            }
            
            const vector = new Array(vectorSize);
            for (let i = 0; i < vectorSize; i++) {
                vector[i] = Math.random() * 2 - 1;
            }

            // Benchmark optimized implementation
            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                const result = matrixVectorMultiplyOptimized(matrix, vector);
                expect(result).toHaveLength(matrixRows);
            }
            const time = performance.now() - start;

            console.log(`Matrix-vector multiplication: ${time.toFixed(2)}ms for ${iterations} iterations`);
            
            // Verify correctness
            const result = matrixVectorMultiplyOptimized(matrix, vector);
            expect(result).toHaveLength(matrixRows);
            expect(result.every(val => Number.isFinite(val))).toBe(true);
        });
    });

    test("Vector arithmetic operations should be efficient", async () => {
        await runWithWatchdog("SIMD vector arithmetic performance test", async () => {
            const vectorSize = 1536;
            const iterations = 100;
            
            // Generate test vectors
            const vecA = new Array(vectorSize);
            const vecB = new Array(vectorSize);
            for (let i = 0; i < vectorSize; i++) {
                vecA[i] = Math.random() * 2 - 1;
                vecB[i] = Math.random() * 2 - 1;
            }

            // Benchmark vector addition
            const addStart = performance.now();
            for (let i = 0; i < iterations; i++) {
                vectorAddOptimized(vecA, vecB);
            }
            const addTime = performance.now() - addStart;

            // Benchmark vector subtraction
            const subStart = performance.now();
            for (let i = 0; i < iterations; i++) {
                vectorSubtractOptimized(vecA, vecB);
            }
            const subTime = performance.now() - subStart;

            // Benchmark vector scaling
            const scaleStart = performance.now();
            for (let i = 0; i < iterations; i++) {
                vectorScaleOptimized(vecA, 0.5);
            }
            const scaleTime = performance.now() - scaleStart;

            console.log(`Vector arithmetic performance:`);
            console.log(`  Addition: ${addTime.toFixed(2)}ms for ${iterations} iterations`);
            console.log(`  Subtraction: ${subTime.toFixed(2)}ms for ${iterations} iterations`);
            console.log(`  Scaling: ${scaleTime.toFixed(2)}ms for ${iterations} iterations`);
            
            // Verify correctness
            const addResult = vectorAddOptimized(vecA, vecB);
            const subResult = vectorSubtractOptimized(vecA, vecB);
            const scaleResult = vectorScaleOptimized(vecA, 0.5);
            
            expect(addResult).toHaveLength(vectorSize);
            expect(subResult).toHaveLength(vectorSize);
            expect(scaleResult).toHaveLength(vectorSize);
            
            expect(addResult.every(val => Number.isFinite(val))).toBe(true);
            expect(subResult.every(val => Number.isFinite(val))).toBe(true);
            expect(scaleResult.every(val => Number.isFinite(val))).toBe(true);
        });
    });

    test("Comprehensive benchmark should show overall performance improvement", async () => {
        await runWithWatchdog("comprehensive SIMD benchmark test", async () => {
            const results = benchmarkVectorOperations(1536, 1000);
            
            console.log("Comprehensive benchmark results:");
            console.log(`  Normalization: ${results.normalizeTime.toFixed(2)}ms`);
            console.log(`  Similarity: ${results.similarityTime.toFixed(2)}ms`);
            console.log(`  Aggregation: ${results.aggregateTime.toFixed(2)}ms`);
            console.log(`  Batch Similarity: ${results.batchSimilarityTime.toFixed(2)}ms`);
            console.log(`  Matrix Multiply: ${results.matrixMultiplyTime.toFixed(2)}ms`);
            console.log(`  Vector Arithmetic: ${results.vectorArithmeticTime.toFixed(2)}ms`);
            console.log(`  Overall Speedup: ${results.overallSpeedup.toFixed(2)}x`);
            
            // Verify all operations completed successfully
            expect(results.normalizeTime).toBeGreaterThan(0);
            expect(results.similarityTime).toBeGreaterThan(0);
            expect(results.aggregateTime).toBeGreaterThan(0);
            expect(results.batchSimilarityTime).toBeGreaterThan(0);
            expect(results.matrixMultiplyTime).toBeGreaterThan(0);
            expect(results.vectorArithmeticTime).toBeGreaterThan(0);
            expect(results.overallSpeedup).toBeGreaterThan(1.0);
        });
    });

    test("Performance monitoring should track operations correctly", async () => {
        await runWithWatchdog("performance monitoring validation test", async () => {
            const stats = VectorOperationStats.getInstance();
            const initialStats = stats.getStats();
            
            // Perform some operations
            const testVec = new Array(1536).fill(0).map(() => Math.random());
            const testVec2 = new Array(1536).fill(0).map(() => Math.random());
            
            normalizeOptimized(testVec);
            cosineSimilarityOptimized(testVec, testVec2);
            aggregateVectorsOptimized([testVec, testVec2]);
            
            const finalStats = stats.getStats();
            
            // Verify stats were updated
            expect(finalStats.normalizations).toBeGreaterThan(initialStats.normalizations);
            expect(finalStats.similarities).toBeGreaterThan(initialStats.similarities);
            expect(finalStats.aggregations).toBeGreaterThan(initialStats.aggregations);
            expect(finalStats.totalTime).toBeGreaterThan(initialStats.totalTime);
        });
    });

    // Test different vector sizes for scalability
    for (const vectorSize of VECTOR_SIZES) {
        test(`Performance scaling for ${vectorSize}D vectors`, async () => {
            await runWithWatchdog(`SIMD performance scaling test for ${vectorSize}D`, async () => {
                const results = benchmarkVectorOperations(vectorSize, 500);
                
                console.log(`${vectorSize}D vector performance:`);
                console.log(`  Overall speedup: ${results.overallSpeedup.toFixed(2)}x`);
                
                // Verify performance scales appropriately
                expect(results.overallSpeedup).toBeGreaterThan(1.0);
                expect(results.normalizeTime).toBeGreaterThan(0);
                expect(results.similarityTime).toBeGreaterThan(0);
            });
        });
    }
});