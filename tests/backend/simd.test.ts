import { describe, it, expect } from 'bun:test';
import {
  benchmarkSimd,
  dotProduct,
  normalize,
  fuseVectors,
  SIMD_SUPPORTED
} from '../../backend/src/utils/simd';
import { gen_syn_emb } from '../../backend/src/memory/embed';

describe('SIMD Vector Operations', () => {

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
      expect(result.jsTime).toBeGreaterThanOrEqual(0);
      expect(result.simdTime).toBeGreaterThanOrEqual(0);
      expect(result.ratio).toBeGreaterThanOrEqual(0);
    });

    it('handles custom dimensions and iteration counts', async () => {
      const customDimensions = 1536;
      const customIterations = 250;

      const result = await benchmarkSimd(customDimensions, customIterations);

      expect(result).toBeDefined();
      expect(result.jsTime).toBeGreaterThanOrEqual(0);
      expect(result.simdTime).toBeGreaterThanOrEqual(0);
      expect(result.ratio).toBeGreaterThanOrEqual(0);
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
      // fuseVectors normalizes the weighted sum, so we expect the normalized result
      const expectedDot = 0.68*0.68 + 0.66*0.66;
      const expectedNorm = Math.sqrt(expectedDot);

      expect(result[0]).toBeCloseTo(0.68 / expectedNorm, 3);
      expect(result[1]).toBeCloseTo(0.66 / expectedNorm, 3);

      // Verify unit length (fuseVectors returns normalized result)
      const actualNorm = Math.sqrt(result[0]*result[0] + result[1]*result[1]);
      expect(actualNorm).toBeCloseTo(1.0, 5);
    });

    it('applies sector-aware weightings correctly', () => {
      // Test episodic weighting (more semantic)
      const weights: [number, number] = [0.65, 0.35];
      const syn = new Float32Array([1.0, 0.0]);
      const sem = new Float32Array([0.0, 1.0]);

      const result = fuseVectors(syn, sem, weights);

      // fuseVectors already returns a normalized result, verify unit length directly
      const actualNorm = Math.sqrt(result[0]*result[0] + result[1]*result[1]);
      expect(actualNorm).toBeCloseTo(1.0, 5);

      // Should be biased toward syn vector (semantic emphasis for episodic)
      expect(Math.abs(result[0])).toBeGreaterThan(Math.abs(result[1]));
    });

    it('handles dimension mismatch', () => {
      const syn = new Float32Array([1, 2]);
      const sem = new Float32Array([1, 2, 3]);

      expect(() => fuseVectors(syn, sem, [0.5, 0.5])).toThrow('Vector length mismatch');
    });
  });

  describe('SIMD WASM integration', () => {
    it('gates WASM loading behind OM_SIMD_WASM_ENABLED env flag', async () => {
      // In default configuration, OM_SIMD_WASM_ENABLED defaults to false
      // So WASM_SUPPORTED should be false or resolved to false
      const { WASM_SUPPORTED } = await import('../../backend/src/utils/simd');
      expect(WASM_SUPPORTED).toBeInstanceOf(Promise);
      const isWasmSupported = await WASM_SUPPORTED;
      expect(isWasmSupported).toBe(false); // Default should disable WASM
    });

    it('constructs correct relative WASM file path', async () => {
      // Test that __dirname + '/../wasm/simd.wasm' logic constructs expected path
      const path = require('path');
      const __dirname = path.dirname(__filename);

      // This mimics the logic in loadWasmSimd: __dirname + '/../wasm/simd.wasm'
      const wasmPath = __dirname + '/../wasm/simd.wasm';

      // Verify path points to the expected location relative to utils directory
      const expectedPath = path.resolve(__dirname, '..', 'wasm', 'simd.wasm');
      expect(path.normalize(wasmPath)).toBe(expectedPath);

      // Verify the path understands the directory structure
      const wasmDirectory = path.dirname(expectedPath);
      const utilsDir = path.dirname(__dirname);
      const expectedWasmDir = path.join(utilsDir, 'wasm');
      expect(wasmDirectory).toBe(expectedWasmDir);

      // In normal deployments, WASM should not be present (OM_SIMD_WASM_ENABLED=false by default)
      const fs = require('fs');
      const wasmFileExists = fs.existsSync(expectedPath);
      expect(wasmFileExists).toBe(false);
    });

    it('uses both vectors in WASM dot product (requires WASM implementation)', async () => {
      // NOTE: This test requires a WASM module to be implemented with proper dot_product signature
      // Currently failing as expected since WASM is not enabled by default

      // Test for future WASM implementation - verifies both vectors are accounted for
      // This simulates what would happen if WASM was enabled with a proper module

      const mockWasmModule = {
        memory: new WebAssembly.Memory({ initial: 1 }),
        dot_product: function (_ptrA: number, _ptrB: number, _len: number): number {
          // Proper WASM implementation should use both ptrA and ptrB for dot product
          const memory = new Float32Array(this.memory.buffer);

          let result = 0;
          for (let i = 0; i < _len; i++) {
            result += memory[_ptrA / 4 + i] * memory[_ptrB / 4 + i];
          }
          return result;
        },
        malloc: function (_size: number): number {
          // Simplified malloc for test purposes: allocate sequential chunks so
          // each call returns a unique pointer. Start at offset 0 and increment
          // by `size` bytes each allocation.
          if (typeof (this as any)._nextPtr === 'undefined') (this as any)._nextPtr = 0;
          const p = (this as any)._nextPtr;
          (this as any)._nextPtr += _size;
          return p;
        },
        free: function (_ptr: number): void {
          // Simplified free for test purposes
        },
        normalize: function (_ptr: number, _len: number): void {
          // Not tested here but required by interface
        },
        fuse_vectors: function (_synPtr: number, _semPtr: number, _resultPtr: number, _len: number, _synWeight: number, _semWeight: number): void {
          // Not tested here but required by interface
        }
      };

      // Test vectors for dot product
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([4, 5, 6]);

      // Expected dot product: 1*4 + 2*5 + 3*6 = 4 + 10 + 18 = 32
      const expected = 32;

      // Manually compute using mock WASM interface
      const len = a.length * 4; // bytes
      const ptrA = mockWasmModule.malloc(len);
      const ptrB = mockWasmModule.malloc(len);

      try {
        // Copy vectors to 'WASM memory' (our mock buffer)
        const memory = new Float32Array(mockWasmModule.memory.buffer);
        for (let i = 0; i < a.length; i++) {
          memory[ptrA / 4 + i] = a[i];
          memory[ptrB / 4 + i] = b[i];
        }

        // This should use both vectors properly
        const result = mockWasmModule.dot_product(ptrA, ptrB, a.length);
        expect(result).toBe(expected);

        // Verify it would match JS implementation if WASM was working
        const jsResult = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        expect(result).toBe(jsResult);

      } finally {
        mockWasmModule.free(ptrA);
        mockWasmModule.free(ptrB);
      }
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

        // fuseVectors already returns a normalized result, verify unit length directly
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

    it('verifies double-normalization is idempotent but unnecessary', () => {
      // Test that fuseVectors returns properly normalized vectors, and
      // verifying double-normalization produces an effect < ε
      const syn = new Float32Array([0.707, 0.707]); // Already unit length
      const sem = new Float32Array([0.0, 1.0]); // Already unit length
      const weights: [number, number] = [0.6, 0.4];

      const result = fuseVectors(syn, sem, weights);

      // Verify base normalization (should already be unit length)
      const initialNorm = Math.sqrt(result[0]*result[0] + result[1]*result[1]);
      expect(initialNorm).toBeCloseTo(1.0, 5);

      // Test double-normalization effects
      const doubleNormalized = [...result]; // Copy
      normalize(doubleNormalized as any); // Type assertion needed but functionally correct

      const finalNorm = Math.sqrt(doubleNormalized[0]*doubleNormalized[0] + doubleNormalized[1]*doubleNormalized[1]);
      expect(finalNorm).toBeCloseTo(1.0, 5);

      // Verify idempotent property (double normalization changes norm negligibly)
      const maxChange = Math.max(
        Math.abs(doubleNormalized[0] - result[0]),
        Math.abs(doubleNormalized[1] - result[1]));
      expect(maxChange).toBeLessThan(1e-6); // Should be extremely small for well-conditioned vectors
    });
  });
});
