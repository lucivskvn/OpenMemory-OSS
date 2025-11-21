import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startServer } from '../../backend/src/server/index';
import fs from 'fs';
import path from 'path';

// Benchmark gating - heavy tests should only run when explicitly allowed
if (process.env.OM_RUN_BENCHMARK_TESTS !== 'true') {
  console.log(
    'Skipping competitor benchmarks (set OM_RUN_BENCHMARK_TESTS=true to run)',
  );
}

describe('competitor benchmarks (OpenMemory vs Mem0/Zep)', () => {
  let server: any = null;
  let baseUrl = '';
  const resultsDir = path.resolve(__dirname, './results');

  beforeAll(async () => {
    if (process.env.OM_RUN_BENCHMARK_TESTS !== 'true') return;

    process.env.OM_TEST_MODE = '1';
    process.env.OM_SKIP_BACKGROUND = 'true';
    process.env.OM_EMBED_KIND = 'synthetic';
    process.env.OM_API_KEYS_ENABLED = 'false';

    server = await startServer({
      port: 0,
      dbPath: ':memory:',
      waitUntilReady: true,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;

    if (!fs.existsSync(resultsDir))
      fs.mkdirSync(resultsDir, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    if (server && server.stop) await server.stop();
  });

  it('should create synthetic dataset and run recall/latency/throughput benchmarks', async () => {
    if (process.env.OM_RUN_BENCHMARK_TESTS !== 'true') return;

    const numMemories = parseInt(
      process.env.OM_BENCHMARK_MEMORIES || '1000',
      10,
    );
    const testQueries = parseInt(process.env.OM_BENCHMARK_QUERIES || '100', 10);

    // Ingest synthetic dataset
    const createdIds: string[] = [];
    for (let i = 0; i < numMemories; i++) {
      const content = `bench-item ${i} about topic-${i % 100}`;
      const res = await fetch(`${baseUrl}/memory/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          metadata: { primary_sector: 'semantic' },
        }),
      });
      expect(res.ok).toBe(true);
      const j = await res.json();
      createdIds.push(j.id);
    }

    // Build queries that should retrieve the seeded memories
    const queries: { q: string; expectedId: string }[] = [];
    for (let i = 0; i < testQueries; i++) {
      const idx = i % numMemories;
      queries.push({ q: `topic-${idx % 100}`, expectedId: createdIds[idx] });
    }

    // Recall@K measurement
    const recallCounts = { k1: 0, k5: 0, k10: 0 }; // counters for correct results
    const latencies: number[] = [];

    for (const qq of queries) {
      const start = performance.now();
      const res = await fetch(`${baseUrl}/memory/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: qq.q, k: 10, filters: {} }),
      });
      const end = performance.now();
      const elapsed = end - start;
      latencies.push(elapsed);

      expect(res.ok).toBe(true);
      const body = await res.json();
      const matches: any[] = body.matches || [];

      if (matches.length > 0 && matches[0].id === qq.expectedId)
        recallCounts.k1++;
      const top5 = matches.slice(0, 5).map((m) => m.id);
      if (top5.includes(qq.expectedId)) recallCounts.k5++;
      const top10 = matches.slice(0, 10).map((m) => m.id);
      if (top10.includes(qq.expectedId)) recallCounts.k10++;
    }

    const recall1 = recallCounts.k1 / queries.length;
    const recall5 = recallCounts.k5 / queries.length;
    const recall10 = recallCounts.k10 / queries.length;

    const latSorted = latencies.slice().sort((a, b) => a - b);
    const p50 = latSorted[Math.floor(latSorted.length * 0.5)];
    const p95 = latSorted[Math.floor(latSorted.length * 0.95)];
    const p99 = latSorted[Math.floor(latSorted.length * 0.99)];

    // Throughput measurement - QPS
    const concurrent = parseInt(
      process.env.OM_BENCHMARK_CONCURRENT || '50',
      10,
    );
    const qpsStart = performance.now();
    await Promise.all(
      Array.from({ length: concurrent }).map(async (_, i) => {
        const idx = i % queries.length;
        await fetch(`${baseUrl}/memory/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: queries[idx].q, k: 5 }),
        });
      }),
    );
    const qpsEnd = performance.now();
    const totalQpsElapsed = (qpsEnd - qpsStart) / 1000;
    const qps = concurrent / Math.max(totalQpsElapsed, 0.0001);

    // Memory usage estimate (best-effort) - approximate DB size
    const memUsage = process.memoryUsage?.()?.heapUsed || 0;

    // Cost estimation for 1M embeddings (synthetic free = 0)
    const costOpenAIPer1M = 0.13;
    const costOpenMemory = 0.0;

    const result = {
      commit: process.env.GITHUB_SHA || null,
      timestamp: new Date().toISOString(),
      metrics: {
        recall1,
        recall5,
        recall10,
        p50,
        p95,
        p99,
        qps,
        memUsage,
      },
      cost: {
        openmemory: costOpenMemory,
        openai: costOpenAIPer1M,
        mem0: costOpenAIPer1M,
        zep: costOpenAIPer1M,
      },
      thresholds: {
        recall5: 0.7,
        recall10: 0.85,
        p95: 50,
        qps: 200,
        memUsage: 600 * 1024 * 1024,
      },
    };

    const file = path.join(
      resultsDir,
      `competitor-comparison-${Date.now()}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(result, null, 2));

    console.table({ recall1, recall5, recall10, p95, qps, memUsage });

    // Assertions against targets (fail if below thresholds)
    expect(recall5).toBeGreaterThanOrEqual(result.thresholds.recall5);
    expect(recall10).toBeGreaterThanOrEqual(result.thresholds.recall10);
    expect(p95).toBeLessThanOrEqual(result.thresholds.p95);
    expect(qps).toBeGreaterThanOrEqual(result.thresholds.qps);
    expect(memUsage).toBeLessThanOrEqual(result.thresholds.memUsage);
  }, 180_000);
});
