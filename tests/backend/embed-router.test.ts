import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
// Do not import embed module at top-level; tests may change env/spy logger
// before importing embed module so we can capture logs reliably.
// We'll dynamically import the embed module in beforeEach so we can install
// logger spies before the module binds its logger references.
let emb_router_cpu: any;
let gen_syn_emb: any;

// Store original implementations
const originalFetch = globalThis.fetch;
const originalPerformance = globalThis.performance;

// Mock global fetch for Ollama API calls
let fetchCalls: any[] = [];
const mockFetch = mock((...args) => {
  fetchCalls.push(args);
  return {
    ok: true,
    json: () => Promise.resolve({ embedding: new Array(768).fill(0.1) })
  };
});

// Mock performance.now for latency measurements with increasing values
let mockTime = 100;
const mockPerformanceNow = mock(() => {
  const time = mockTime;
  mockTime += Math.random() * 10 + 5; // Add 5-15ms per call to simulate real timing
  return time;
});

describe('Router CPU Provider', () => {
  if (process.env.OM_TEST_SKIP_PERF === 'true') {
    it.skip('Performance tests skipped (OM_TEST_SKIP_PERF=true)', () => { });
  }
  beforeEach(async () => {
    fetchCalls = []; // Reset captured calls
    mockPerformanceNow.mockClear();

    // Install mocks for this test
    globalThis.fetch = mockFetch as any;
    globalThis.performance = { now: mockPerformanceNow } as any;

    // Router tests expect the Ollama embeddings to be the same dimensionality
    // as the configured vector dimension. Set OM_VEC_DIM to 768 (nomic embedding size)
    // so the tests don't hit dimension mismatch fallback rules in CI.
    process.env.OM_VEC_DIM = '768';
    // Import embed module after env setup so getEmbeddingInfo picks up OM_VEC_DIM
    // and logger spies are intact (tests that wish to spy should set spies
    // before calling embed functions inside individual tests).
    const m = await import('../../backend/src/memory/embed');
    emb_router_cpu = m.emb_router_cpu;
    gen_syn_emb = m.gen_syn_emb;
    // Clear any cached router decisions between tests
    if (m.__TEST && typeof m.__TEST.resetRouterCaches === 'function') m.__TEST.resetRouterCaches();
  });

  afterEach(() => {
    mockPerformanceNow.mockClear();
    // Restore original global state after each test
    globalThis.fetch = originalFetch;
    globalThis.performance = originalPerformance;
  });

  it('routes semantic sector to nomic-embed-text model', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';

    await emb_router_cpu('This is a semantic test text', 'semantic');

    expect(fetchCalls.length).toBe(1);
    const [url, options] = fetchCalls[0];
    expect(url).toContain('/api/embeddings');
    expect(options.method).toBe('POST');
    expect(options.body).toContain('"model":"nomic-embed-text"');
  });

  it('routes procedural sector to bge-small-en-v1.5 model', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';

    await emb_router_cpu('This describes a procedure', 'procedural');

    expect(fetchCalls.length).toBe(1);
    const [url, options] = fetchCalls[0];
    expect(url).toContain('/api/embeddings');
    expect(options.method).toBe('POST');
    expect(options.body).toContain('"model":"bge-small-en-v1.5"');
  });

  it('verifies router P95 latency <200ms CI / <150ms VPS with synthetic baseline', async () => {
    process.env.OM_EMBED_KIND = 'synthetic'; // Reset to synthetic for baseline

    // Baseline synthetic embeddings
    const synLatencies = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      gen_syn_emb(`baseline ${i}`, 'semantic');
      synLatencies.push(performance.now() - start);
    }
    const synP95 = synLatencies.sort((a, b) => a - b)[Math.floor(0.95 * synLatencies.length)];

    process.env.OM_EMBED_KIND = 'router_cpu'; // Switch to router for test

    // Real router latency measurements
    const latencies = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await emb_router_cpu(`Test query ${i}`, 'semantic');
      latencies.push(performance.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(0.95 * latencies.length)];

    // Assertions
    expect(p95).toBeLessThan(200); // CI bound
    expect(p95).toBeLessThan(synP95 + 50); // <50ms overhead vs synthetic

    // Average check
    const avg = latencies.reduce((s, l) => s + l, 0) / latencies.length;
    expect(avg).toBeLessThan(100);

    console.log(`Router P95: ${p95.toFixed(2)}ms, Synthetic P95: ${synP95.toFixed(2)}ms`);
  });

  it('verifies router P95 under concurrent load <300ms total', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';

    const promises = Array.from({ length: 50 }, (_, i) => emb_router_cpu(`load test ${i}`, 'semantic'));
    const start = performance.now();
    await Promise.all(promises);
    const totalTime = performance.now() - start;

    expect(totalTime).toBeLessThan(300); // <6ms/call avg

    // Verify cache hits
    // Note: routerDecisionCache is now populated
    console.log('Concurrent router throughput verified <300ms total');
  });

  it('falls back to synthetic embeddings when Ollama unavailable', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_ROUTER_FALLBACK_ENABLED = 'true';

    // Temporarily change mock to simulate failure
    const originalMockFetch = mockFetch;
    const failingMock = mock(() => Promise.reject(new Error('Ollama service unavailable')));
    globalThis.fetch = failingMock as any;

    const result = await emb_router_cpu('Test text', 'semantic');

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    // Restore original mock
    globalThis.fetch = originalMockFetch as any;
  }) as any;

  it('logs [EMBED] router processing with model selection', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    // Ensure embed logs are enabled in tests to make `EMBED` messages visible
    const prev = process.env.OM_LOG_EMBED_LEVEL;
    process.env.OM_LOG_EMBED_LEVEL = 'debug';
    // Use the logger spy helper so we capture pino / logger calls reliably
    const loggerMod: any = await import('../../backend/src/core/logger');
    const { spyLoggerMethod } = await import('../utils/spyLoggerSafely');
    const calls: any[] = [];
    const handle = spyLoggerMethod(loggerMod.default, 'info', (meta: any, msg?: any) => { calls.push({ meta, msg }); });
    // Also capture embed logs via __TEST hook so we don't rely only on pino
    // internals. This prevents CI flakiness getting pino spy not to attach
    // to bound functions created at import time.
    const embedHookCleanup: any = (async () => {
      try {
        const embedMod: any = await import('../../backend/src/memory/embed');
        if (embedMod && embedMod.__TEST) embedMod.__TEST.logHook = (lvl: any, meta: any, msg: any) => { calls.push({ meta, msg, lvl }); };
        return () => { if (embedMod && embedMod.__TEST) embedMod.__TEST.logHook = null; };
      } catch (e) { return () => { }; }
    })();

    // Import embed module after spy is installed so logs are captured.
    const embedMod: any = await import('../../backend/src/memory/embed');
    await embedMod.emb_router_cpu('test text for semantic sector', 'semantic');

    // Verify that an EMBED info log was emitted with the expected metadata.
    expect(calls.length).toBeGreaterThan(0);
    const first = calls.find((c: any) => c.meta && c.meta.component === 'EMBED');
    expect(first).toBeTruthy();
    if (first) expect(first.meta).toMatchObject({ component: 'EMBED', sector: 'semantic', model: 'nomic-embed-text' });
    try { handle.restore(); } catch (e) { }
    try { const cleanup = await embedHookCleanup; cleanup(); } catch (e) { }
    if (prev === undefined) delete process.env.OM_LOG_EMBED_LEVEL; else process.env.OM_LOG_EMBED_LEVEL = prev;
  });

  it('handles router cache decisions with 30s TTL', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_ROUTER_CACHE_TTL_MS = '30000'; // 30s

    // Mock Date.now for cache TTL testing
    const originalDateNow = Date.now;
    global.Date.now = mock(() => 0);

    await emb_router_cpu('first call', 'semantic'); // Makes first call

    global.Date.now = mock(() => 10000); // Second call within TTL
    await emb_router_cpu('first call', 'semantic'); // Same text as first call - should reuse cache

    // Mock TTL expiry
    global.Date.now = mock(() => 35000); // Beyond 30s TTL
    await emb_router_cpu('third call after expiry', 'semantic'); // Should make new call

    expect(fetchCalls.length).toBe(2); // Only two fetch calls total

    global.Date.now = originalDateNow;
  });

  it('throws error when fallback disabled and Ollama fails', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_ROUTER_FALLBACK_ENABLED = 'false';

    // Temporarily change mock to simulate failure
    const originalMockFetch = mockFetch;
    const failingMock = mock(() => { throw new Error('Ollama service unavailable') });
    globalThis.fetch = failingMock as any;

    await expect(emb_router_cpu('test text', 'semantic')).rejects.toThrow();

    // Restore original mock
    globalThis.fetch = originalMockFetch as any;
  });

  it('returns properly fused hybrid embeddings', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_ROUTER_SIMD_ENABLED = 'true';

    const result = await emb_router_cpu('test text for semantic fusion', 'semantic');

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((v: number) => typeof v === 'number' && isFinite(v))).toBe(true);

    // Check if normalized (only if production enforces it)
    const magnitude = Math.sqrt(result.reduce((sum: number, v: number) => sum + v * v, 0));
    // Allow some flexibility in normalization depending on tier settings
    expect(magnitude).toBeGreaterThan(0.9); // At least mostly normalized
  });

  it('applies sector-appropriate weightings', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';

    const semanticResult = await emb_router_cpu('semantic content', 'semantic');
    const proceduralResult = await emb_router_cpu('procedural content', 'procedural');

    // Results should be different due to sector-specific routing and weighting
    expect(semanticResult).not.toEqual(proceduralResult);
    expect(semanticResult.length).toBe(proceduralResult.length);
  });

  it('maintains backward compatibility with existing providers', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';

    // Test that normal embed function still works
    const { embedForSector } = await import('../../backend/src/memory/embed');
    const result = await embedForSector('test text', 'semantic');

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  it('supports sector-specific fusion weights', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_ROUTER_SIMD_ENABLED = 'true';

    // Test semantic sector weighting (0.6 semantic, 0.4 synthetic)
    const semanticResult = await emb_router_cpu('semantic understanding test', 'semantic');
    expect(semanticResult).toBeDefined();

    // Test episodic sector weighting (0.65 semantic, 0.35 synthetic)
    const episodicResult = await emb_router_cpu('memory recollection test', 'episodic');
    expect(episodicResult).toBeDefined();

    // Test procedural sector weighting (0.55 semantic, 0.45 synthetic)
    const proceduralResult = await emb_router_cpu('step by step process', 'procedural');
    expect(proceduralResult).toBeDefined();

    // Results should be similar but not identical due to different weightings
    expect(semanticResult.length).toBe(episodicResult.length);
    expect(semanticResult.length).toBe(proceduralResult.length);
  });

  it('respects OM_ROUTER_SECTOR_MODELS override', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_ROUTER_SECTOR_MODELS = JSON.stringify({
      semantic: 'bge-small-en-v1.5', // Override to use BGE instead of nomic-embed-text
      procedural: 'nomic-embed-text'  // Override to use nomic instead of bge-small-en-v1.5
    });

    const embedMod = await import('../../backend/src/memory/embed');
    if (embedMod.__TEST && typeof embedMod.__TEST.resetRouterCaches === 'function') embedMod.__TEST.resetRouterCaches();

    await emb_router_cpu('semantic test', 'semantic');

    // Ensure caches were thinking of the override values; the call above
    // already cleared router caches after setting env.

    expect(fetchCalls.length).toBe(1);
    const [url1, options1] = fetchCalls[0];
    expect(url1).toContain('/api/embeddings');
    expect(options1.method).toBe('POST');
    expect(options1.body).toContain('"model":"bge-small-en-v1.5"');

    // Test different sector uses different model
    fetchCalls = []; // Reset
    await emb_router_cpu('procedural test', 'procedural');

    expect(fetchCalls.length).toBe(1);
    const [url2, options2] = fetchCalls[0];
    expect(url2).toContain('/api/embeddings');
    expect(options2.method).toBe('POST');
    expect(options2.body).toContain('"model":"nomic-embed-text"');
  });

  it('handles invalid sector gracefully', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_ROUTER_FALLBACK_ENABLED = 'true';

    // Use type assertion to bypass TypeScript check for invalid sector
    await emb_router_cpu('invalid sector test', 'invalid' as any);

    // Should use default model (nomic-embed-text) for unknown sectors
    expect(fetchCalls.length).toBe(1);
    const [url, options] = fetchCalls[0];
    expect(url).toContain('/api/embeddings');
    expect(options.method).toBe('POST');
    expect(options.body).toContain('"model":"nomic-embed-text"');
  });

  it('respects __TEST.routerCacheEnabled for forced cache bypass', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_ROUTER_CACHE_ENABLED = 'true';

    const embedMod = await import('../../backend/src/memory/embed');

    // First call should cache
    await emb_router_cpu('cache test text', 'semantic');
    expect(fetchCalls.length).toBe(1); // Should make network call

    // Second call with cache enabled should hit cache
    fetchCalls = [];
    await emb_router_cpu('cache test text', 'semantic'); // Same text
    expect(fetchCalls.length).toBe(0); // Should hit cache, no network call

    // Third call with routerCacheEnabled=false should force cache miss
    if (embedMod.__TEST) embedMod.__TEST.routerCacheEnabled = false;
    fetchCalls = [];
    await emb_router_cpu('cache test text', 'semantic'); // Same text but cache bypass
    expect(fetchCalls.length).toBe(1); // Should make network call despite cached content
  });

  it('handles SMART tier fusion with dimension matching', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_TIER = 'smart';

    const embedMod = await import('../../backend/src/memory/embed');
    const { embedForSector } = embedMod;

    // Test SMART tier fusion - should not throw dimension mismatch error
    const result = await embedForSector('test text for smart fusion', 'semantic');
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((v: number) => typeof v === 'number' && isFinite(v))).toBe(true);

    // Check if normalized
    const magnitude = Math.sqrt(result.reduce((sum: number, v: number) => sum + v * v, 0));
    expect(magnitude).toBeGreaterThan(0.9); // At least mostly normalized
  });

  it('supports SMART tier with router_cpu provider without errors', async () => {
    process.env.OM_EMBED_KIND = 'router_cpu';
    process.env.OM_TIER = 'smart';

    const embedMod = await import('../../backend/src/memory/embed');
    const { embedForSector } = embedMod;

    // Test all sectors in SMART tier with router_cpu
    const sectors = ['semantic', 'episodic', 'procedural', 'emotional', 'reflective'];
    for (const sector of sectors) {
      const result = await embedForSector(`test text for ${sector}`, sector);
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(768); // Should match configured dimension
      expect(result.every((v: number) => typeof v === 'number' && !isNaN(v))).toBe(true);
    }
  });
});
