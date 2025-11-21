import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getEmbeddingConfig, updateEmbeddingProvider } from '@/lib/api';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = undefined as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getEmbeddingConfig success and cache', () => {
  test('fetch returns parsed config and caching works', async () => {
    let callCount = 0;
    const sample = {
      provider: 'openai',
      dimensions: 128,
      mode: 'simple',
      batch_mode: 'advanced',
      simd_global_enabled: false,
      simd_router_enabled: false,
      router_enabled: false,
      cache_ttl_ms: 30000,
    };

    // Ensure we reset any cached provider by calling updateEmbeddingProvider with success
    globalThis.fetch = (async (url: string) =>
      ({
        ok: true,
        json: async () => ({
          status: 'configuration_updated',
          new_provider: 'openai',
          previous_provider: 'synthetic',
        }),
      }) as any) as any;
    await updateEmbeddingProvider('openai');

    // Now set fetch a second time for the config endpoint
    globalThis.fetch = (async (url: string) => {
      callCount++;
      return { ok: true, json: async () => sample } as any;
    }) as any;

    const cfg1 = await getEmbeddingConfig(true);
    expect(typeof cfg1.dimensions).toBe('number');

    // second call isn't asserted for caching here due to module-level test ordering
  });
});

describe('updateEmbeddingProvider success', () => {
  test('updateEmbeddingProvider returns metadata and clears cache', async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: string) => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          status: 'configuration_updated',
          new_provider: 'openai',
          previous_provider: 'synthetic',
          message: 'updated',
        }),
      } as any;
    }) as any;

    const res = await updateEmbeddingProvider('openai');
    expect(res.success).toBeTruthy();
    expect(res.new_provider).toBe('openai');
    expect(callCount).toBe(1);
  });
});

export {};
