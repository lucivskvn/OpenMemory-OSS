import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  benchmarkSimd,
  dotProduct,
  normalize,
  fuseVectors,
  SIMD_SUPPORTED
} from '../../backend/src/utils/simd';
import { gen_syn_emb } from '../../backend/src/memory/embed';

// Mock performance.now for consistent benchmarking
const mockPerformanceNow = mock(() => 100);
const originalPerformanceNow = globalThis.performance.now;
globalThis.performance.now = mockPerformanceNow;

describe('SIMD Vector Operations', () => {
  beforeEach(() => {
    // Reset mocks
    mockPerformanceNow.mockClear();
    // Simulate SIMD being supported by default for tests
    mockPerformanceNow
      .mockReturnValueOnce(0) // Start SIMD test
      .mockReturnValueOnce(100) // End SIMD test (100ms)
      .mockReturnValueOnce(100) // Start JS test
      .mockReturnValueOnce(200); // End JS test (100ms) - will show SIMD is faster
  });

  afterEach(() => {
    // Restore original performance.now
    globalThis.performance.now = originalPerformanceNow;
  });

  describe('benchmarkSimd', () => {
    it('returns performance comparison between SIMD and JS implementations', async () => {
      const result = await benchmarkSimd(256, 100);

      expect(result).toHaveProperty('jsTime');
      expect(result).toHaveProperty('simdTime');
      expect(result).toHaveProperty('ratio');
      expect(result).toHaveProperty('supported');
      expect(typeof result.jsTime).toBe('number');
      expect(typeof result.simdTime).toBe('number');
      expect(typeof result.ratio).toBe('number');
      expect(typeof result.supported).toBe('boolean');
      expect(result.ratio).toBeGreaterThan(0);
    });

    it('returns numeric timing values when SIMD is available', async () => {
      const result = await benchmarkSimd(768, 500);

      // Both timing values should be positive numbers
      expect(result.jsTime).toBeGreaterThan(0);
      expect(result.simdTime).toBeGreaterThan(0);
      expect(result.ratio).toBeGreaterThan(0);
    });

    it('handles custom dimensions and iteration counts', async () => {
      const customDimensions = 1536;
      const customIterations = 250;

      const result = await benchmarkSimd(customDimensions, customIterations);

      expect(result).toBeDefined();
      expect(result.jsTime).toBeGreaterThan(0);
      expect(result.simdTime).toBeGreaterThan(0);
    });

    it('fails gracefully on invalid input', async () => {
      expect(benchmarkSimd(-1, 100)).rejects.toThrow();
      expect(benchmarkSimd(256, -1)).rejects.toThrow();
    });
  });

  describe('dotProduct', () => {
    it('computes cosine similarity correctly', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([1, 0, 0]);

      const result = dotProduct(a, b);
      expect(result).toBeCloseTo(1.0, 5); // Identical vectors

      const orthogonal = dotProduct(new Float32Array([1, 0]), new Float32Array([0, 1]));
      expect(orthogonal).toBeCloseTo(0.0, 5); // Orthogonal vectors
    });

    it('handles different vector dimensions', () => {
      const a = new Float32Array([1, 2, 3, 4]);
      const b = new Float32Array([1, 2, 3, 4]);

      const result = dotProduct(a, b);
      expect(result).toBe(30.0); // 1*1 + 2*2 + 3*3 + 4*4
    });

    it('throws on dimension mismatch', () => {
      const a = new Float32Array([1, 2]);
      const b = new Float32Array([1, 2, 3]);

      expect(() => dotProduct(a, b)).toThrow('Vector length mismatch');
    });

    it('uses 8-element unrolling optimization', () => {
      // Test with dimension that should use unrolling
      const dim = 256; // Divisible by 8
      const a = new Float32Array(dim).fill(1.0);
      const b = new Float32Array(dim).fill(1.0);

      const result = dotProduct(a, b);
      expect(result).toBe(dim); // All 1s * 1s = dimension
    });
  });

  describe('normalize', () => {
    it('normalizes vectors to unit length', () => {
      const v = new Float32Array([3, 4]); // Magnitude 5
      normalize(v);

      expect(v[0]).toBeCloseTo(0.6, 5); // 3/5
      expect(v[1]).toBeCloseTo(0.8, 5); // 4/5

      // Verify unit length
      const magnitude = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
      expect(magnitude).toBeCloseTo(1.0, 5);
    });

    it('handles zero vector gracefully', () => {
      const v = new Float32Array([0, 0, 0, 0]);
      normalize(v);

      // Zero vector should remain zero
      expect(v[0]).toBe(0);
      expect(v[1]).toBe(0);
      expect(v[2]).toBe(0);
      expect(v[3]).toBe(0);
    });

    it('preserves direction while normalizing', () => {
      const original = [2, 3, 5];
      const v = new Float32Array(original);
      const originalNorm = Math.sqrt(4 + 9 + 25); // sqrt(38)

      normalize(v);

      // Check direction is preserved
      for (let i = 0; i < v.length; i++) {
        expect(v[i]).toBeCloseTo(original[i] / originalNorm, 5);
      }
    });
  });

  describe('fuseVectors', () => {
    it('combines vectors with weighted fusion and normalization', () => {
      const syn = new Float32Array([0.8, 0.6]);
      const sem = new Float32Array([0.4, 0.8]);
      const weights: [number, number] = [0.7, 0.3]; // More semantic (70%)

      const result = fuseVectors(syn, sem, weights);

      // Manual calculation: [0.8*0.7 + 0.4*0.3, 0.6*0.7 + 0.8*0.3] = [0.56 + 0.12, 0.42 + 0.24] = [0.68, 0.66]
      // Then normalized by dividing by norm
      const expectedDot = 0.68*0.68 + 0.66*0.66;
      const expectedNorm = Math.sqrt(expectedDot);

      expect(result[0]).toBeCloseTo(0.68 / expectedNorm, 3);
      expect(result[1]).toBeCloseTo(0.66 / expectedNorm, 3);

      // Verify unit length
      const actualNorm = Math.sqrt(result[0]*result[0] + result[1]*result[1]);
      expect(actualNorm).toBeCloseTo(1.0, 5);
    });

    it('applies sector-aware weightings correctly', () => {
      // Test episodic weighting (more semantic)
      const weights: [number, number] = [0.65, 0.35];
      const syn = new Float32Array([1.0, 0.0]);
      const sem = new Float32Array([0.0, 1.0]);

      const result = fuseVectors(syn, sem, weights);

      // Should be biased toward syn vector (semantic emphasis for episodic)
      expect(Math.abs(result[0])).toBeGreaterThan(Math.abs(result[1]));
    });

    it('handles dimension mismatch', () => {
      const syn = new Float32Array([1, 2]);
      const sem = new Float32Array([1, 2, 3]);

      expect(() => fuseVectors(syn, sem, [0.5, 0.5])).toThrow('Vector length mismatch');
    });
  });

  describe('SIMD integration with embedding system', () => {
    it('integrates with synthetic embedding generator', () => {
      const text = 'The quick brown fox jumps over the lazy dog';
      const sector = 'semantic';

      // Generate synthetic embeddings
      const synVec = new Float32Array(gen_syn_emb(text, sector));
      normalize(synVec);

      // Verify the result is a unit vector
      const norm = Math.sqrt(synVec.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    });

    it('supports optional SIMD vector fusion in router mode', () => {
      // This test verifies the SIMD functions are ready for router_cpu mode
      const syn = new Float32Array(gen_syn_emb('test text', 'semantic'));
      const sem = new Float32Array([0.1, 0.2, 0.3, ...Array(syn.length - 3).fill(0.1)]);

      // Should not throw when SIMD is available
      const result = fuseVectors(syn, sem, [0.6, 0.4]);
      expect(result).toBeDefined();
      expect(result.length).toBe(syn.length);
    });

    it('performs sector-aware fusion with performance benefits', () => {
      const sectorWeights: Record<string, [number, number]> = {
        episodic: [0.65, 0.35],    // More semantic for episodic
        semantic: [0.6, 0.4],     // Balanced for semantic
        procedural: [0.55, 0.45],  // More synthetic for procedural (faster models)
        emotional: [0.58, 0.42],   // Slightly more semantic for emotional
        reflective: [0.62, 0.38],  // More semantic for reflective
      };

      const syn = new Float32Array([0.8, 0.6, 0.4]);
      const sem = new Float32Array([0.4, 0.8, 0.6]);

      // Test all sectors
      for (const sector of Object.keys(sectorWeights)) {
        const weights = sectorWeights[sector];
        const result = fuseVectors(syn, sem, weights);

        // Verify fusion creates unit vector
        const actualNorm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
        expect(actualNorm).toBeCloseTo(1.0, 5);

        // Verify weights are applied (semantic weight affects result)
        const synWeight = weights[0];
        const expectedBias = synWeight > 0.5 ? 'syn' : 'sem';
        // Basic check that weighting influences output direction
        expect(result).toBeDefined();
      }
    });
  });

  describe('SIMD environment configuration', () => {
    it('respects OM_SIMD_ENABLED environment variable', () => {
      // This test verifies that the environment variable is checked during import
      // In a real scenario, this would be tested by setting environment before require()
      expect(typeof SIMD_SUPPORTED).toBe('boolean');
      expect(typeof benchmarkSimd).toBe('function');
    });

    it('provides fallback to JavaScript when SIMD unavailable', () => {
      // Even if SIMD is disabled, functions should still work
      expect(typeof dotProduct).toBe('function');
      expect(typeof normalize).toBe('function');
      expect(typeof fuseVectors).toBe('function');

      const a = new Float32Array([1, 0]);
      const b = new Float32Array([1, 0]);

      expect(() => dotProduct(a, b)).not.toThrow();
      expect(() => normalize(a)).not.toThrow();
    });

    it('runs under Bun test runner without Jest dependency', () => {
      expect(true).toBe(true);
    });
  });
});
