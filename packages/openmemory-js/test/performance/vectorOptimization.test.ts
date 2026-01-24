/**
 * @file Vector Optimization Performance Tests
 * Benchmarks and validates the optimized vector operations
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { 
    normalize as normalizeOriginal,
    cosineSimilarity as cosineSimilarityOriginal,
    aggregateVectors as aggregateVectorsOriginal
} from "../../src/utils/vectors";
import {
    normalizeOptimized,
    cosineSimilarityOptimized,
    aggregateVectorsOptimized,
    batchCosineSimilarity,
    benchmarkVectorOperations,
    VectorOperationStats,
    resizeVectorOptimized,
    euclideanDistanceOptimized
} from "../../src/utils/vectorsOptimized";
import { runWithWatchdog } from "../../src/utils/testWatchdog";

describe("Vector Optimization Performance Tests", () => {
    const VECTOR_SIZES = [128, 384, 768, 1536]; // Common embedding dimensions
    const NUM_VECTORS = [100, 500, 1000];
    
    let testVectors: Map<number, number[][]>;
    
    beforeAll(async () => {
        // Generate test vectors for different dimensions
        testVectors = new Map();
        
        for (const size of VECTOR_SIZES) {
            const vectors: number[][] = [];
            for (let i = 0; i < Math.max(...NUM_VECTORS); i++) {
                const vector = new Array(size);
                for (let j = 0; j < size; j++) {
                    vector[j] = Math.random() * 2 - 1; // Random values between -1 and 1
                }
                vectors.push(vector);
            }
            testVectors.set(size, vectors);
        }
    });

    test("should normalize vectors correctly", async () => {
        await runWithWatchdog("vector normalization test", async () => {
            for (const size of VECTOR_SIZES) {
                const vectors = testVectors.get(size)!;
                const testVector = vectors[0];
                
                const originalResult = normalizeOriginal(testVector);
                const optimizedResult = normalizeOptimized(testVector);
                
                // Results should be very close (within floating point precision)
                expect(originalResult.length).toBe(optimizedResult.length);
                
                for (let i = 0; i < originalResult.length; i++) {
                    expect(Math.abs(originalResult[i] - optimizedResult[i])).toBeLessThan(1e-10);
                }
                
                // Verify normalization (length should be 1)
                const norm = Math.sqrt(optimizedResult.reduce((sum, val) => sum + val * val, 0));
                expect(Math.abs(norm - 1.0)).toBeLessThan(1e-10);
            }
        }, 10000);
    });

    test("should compute cosine similarity correctly", async () => {
        await runWithWatchdog("cosine similarity test", async () => {
            for (const size of VECTOR_SIZES) {
                const vectors = testVectors.get(size)!;
                const vectorA = vectors[0];
     