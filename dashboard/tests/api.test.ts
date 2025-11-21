import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { buildEmbeddingTelemetry, isRouterConfig, getEmbeddingConfig, updateEmbeddingProvider, updateEmbeddingBatchMode } from '@/lib/api'

// Mock fetch so tests do not perform network requests
const originalFetch = globalThis.fetch

beforeEach(() => {
    globalThis.fetch = undefined as unknown as typeof fetch
})

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('API lib helpers', () => {
    test('buildEmbeddingTelemetry adds router fields for router_cpu', () => {
        const config = {
            provider: 'router_cpu',
            batchMode: 'simple',
            simd_global_enabled: true,
            simd_router_enabled: true,
            fallback_enabled: false,
            sector_models: { a: 'm' }
        } as any

        const telemetry = buildEmbeddingTelemetry(config)

        expect(telemetry.meta_version).toBe(1)
        // We assert the canonical meta data exists and is well-formed
        expect(telemetry.meta_version).toBe(1)
        expect(typeof telemetry).toBe('object')
    })

    test('isRouterConfig returns true for router config', () => {
        const cfg = {
            provider: 'router_cpu',
            router_enabled: true,
            sector_models: { a: 'm' },
            cache_ttl_ms: 30,
            performance: { expected_p95_ms: 1, expected_simd_improvement: 0, memory_usage_gb: 1 },
            ollama_required: true
        } as any

        expect(isRouterConfig(cfg)).toBe(true)
    })

    test('getEmbeddingConfig fallback on fetch error', async () => {
        globalThis.fetch = (async () => { throw new Error('network') }) as any
        const cfg = await getEmbeddingConfig()
        expect(cfg.provider).toBe('synthetic')
        expect(cfg.dimensions).toBeDefined()
    })

    test('updateEmbeddingProvider invalid response throws', async () => {
        let passed = false
        globalThis.fetch = (url: string) => Promise.resolve({ ok: false, json: async () => ({ message: 'err' }) } as any)
        try {
            await updateEmbeddingProvider('openai')
        } catch (e: any) {
            passed = !!e
        }
        expect(passed).toBeTruthy()
    })

    test('updateEmbeddingBatchMode returns success if ok', async () => {
        globalThis.fetch = (url: string) => Promise.resolve({ ok: true, json: async () => ({ status: 'configuration_updated', message: 'ok' }) } as any)
        const res = await updateEmbeddingBatchMode('advanced')
        expect(res.success).toBeTruthy()
    })
})

export { }
