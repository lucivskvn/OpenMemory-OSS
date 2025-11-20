import { env } from '../../core/cfg';
import logger from '../../core/logger';
import { getEmbeddingInfo, getOllamaHealth, updateRuntimeConfig, __TEST_ollama } from '../../memory/embed';

/**
 * In-memory cache for Ollama management endpoints only.
 * Currently limited to 'ollama_list' and 'ollama_status' keys.
 * Do not use for cross-module caching.
 */
const cache = new Map<string, { data: any; expires: number }>();

/**
 * Get cached value if not expired
 */
function getCache(key: string): any | null {
    const entry = cache.get(key);
    if (entry && Date.now() < entry.expires) {
        return entry.data;
    }
    cache.delete(key);
    return null;
}

/**
 * Set cache with TTL in milliseconds
 * Includes size guard to prevent unbounded growth
 */
function setCache(key: string, data: any, ttlMs: number): void {
    // Simple size guard: limit to 5 entries max
    if (cache.size >= 5) {
        // Delete oldest (first inserted)
        const oldestKey = cache.keys().next().value;
        if (oldestKey) {
            cache.delete(oldestKey);
        }
    }
    cache.set(key, { data, expires: Date.now() + ttlMs });
}

/**
 * Retry helper with exponential backoff
 * Tuned for different endpoint requirements:
 * - Pull: higher timeout (10000ms) for large model downloads, 4 attempts with base 1000ms delay
 * - Other: standard timeout (1000ms), 3 attempts with base 500ms delay
 */
// Helper to perform fetch with a per-request timeout using AbortController
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 300): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        return resp;
    } finally {
        clearTimeout(id);
    }
}

async function retryFetch(url: string, options: RequestInit, attempts = 1, timeoutMs = 300, baseDelayMs = 200): Promise<Response> {
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await fetchWithTimeout(url, options, timeoutMs);
            return response;
        } catch (error) {
            if (i === attempts - 1) throw error;
            const backoff = baseDelayMs * Math.pow(2, i);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
    throw new Error('Retry attempts exhausted');
}

/**
 * Validate model name (alphanumeric + hyphens/colons only)
 */
function isValidModelName(name: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(name);
}

/**
 * Ollama management API routes
 * Note: Pull handler response status is intentionally conservative to avoid
 * misrepresenting async progress from Ollama /api/pull stream: false.
 * MCP consumers should monitor progress externally if needed.
 */
export function embed(app: any): void {
    const baseUrl = env.ollama_url;

    // Configurable timeout and backoff defaults for Ollama API calls
    const DEFAULT_TIMEOUT_MS = 1000;
    const DEFAULT_BACKOFF_MS = 500;

    /**
     * POST /embed/ollama/pull
     * Pull/download an Ollama model
     * Uses heavier retry profile (4 attempts, 10000ms timeout, exponential backoff starting at 1000ms)
     * suited for large model downloads and MCP orchestration.
     */
    app.post('/embed/ollama/pull', async (req: Request, ctx: any) => {
        try {
            // Prefer parsed body from server middleware when available
            let body: any = (ctx && (ctx as any).body) ? (ctx as any).body : undefined;
            if (!body) {
                try {
                    body = await req.clone().json();
                } catch (e) {
                    body = undefined;
                }
            }
            const { model, tag = 'latest', mcp_task_id } = body || {};

            if (!model || typeof model !== 'string') {
                return new Response(
                    JSON.stringify({
                        error: 'model required',
                        error_code: 'invalid_request',
                        message: 'Model name required',
                        context: { timestamp: new Date().toISOString(), path: '/embed/ollama/delete' }
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            if (!isValidModelName(model)) {
                return new Response(
                    JSON.stringify({
                        error: 'Invalid model name',
                        error_code: 'invalid_model',
                        message: 'Model name contains invalid characters',
                        context: { timestamp: new Date().toISOString(), model, path: '/embed/ollama/delete' }
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            let modelName: string | undefined;
            let startTs = Date.now();

            try {
                // Test seam: if an Ollama tag list has been injected for tests,
                // use that instead of calling the external service. This allows
                // tests to run without a live Ollama instance.
                if ((__TEST_ollama as any).tags !== undefined) {
                    const tags = typeof (__TEST_ollama as any).tags === 'function' ? await (__TEST_ollama as any).tags() : (__TEST_ollama as any).tags;
                    const models = tags.models || tags;
                    const result = {
                        models: models.map((m: any) => ({ name: m.name || m, size: m.size || 0, modified_at: m.modified_at || null })),
                        count: models.length,
                        ollama_url: baseUrl,
                        context: { generated_at: new Date().toISOString(), ollama_url: baseUrl }
                    };
                    setCache('ollama_list', result, 30000);
                    return new Response(JSON.stringify({ ...result, cached: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                modelName = tag && tag !== 'latest' ? `${model}:${tag}` : model;

                logger.info({ component: 'EMBED', modelName, mcp_task_id }, 'Pulling Ollama model...');

                // Long model downloads can legitimately take up to a minute or more
                // Test seam for pull: allow tests to override the pull behavior
                if ((__TEST_ollama as any).pull) {
                    const simulated = typeof (__TEST_ollama as any).pull === 'function' ? await (__TEST_ollama as any).pull(modelName) : (__TEST_ollama as any).pull;
                    return new Response(JSON.stringify(simulated), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }

                let response;
                response = await retryFetch(
                    `${baseUrl}/api/pull`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: modelName, stream: false })
                    },
                    4, 60000, 1000
                );

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error({ component: 'EMBED', model: modelName, status: response.status }, 'Ollama pull failed');
                    return new Response(
                        JSON.stringify({
                            error: 'Failed to pull model',
                            error_code: 'pull_failed',
                            message: `Failed to pull model: ${response.statusText}`,
                            context: { status: response.status, detail: errorText }
                        }),
                        { status: response.status, headers: { 'Content-Type': 'application/json' } }
                    );
                }

                const result = await response.json();
                logger.info({ component: 'EMBED', model: modelName, mcp_task_id, elapsed_ms: Date.now() - startTs }, 'Model pull completed');

                // Default to async 'pulling' status for HTTP 200 with stream: false
                // Only indicate 'completed' if response clearly shows terminal done state
                const pullStatus = result.status || 'unknown';
                const isCompleted = result.done === true || (typeof result.done === 'string' && result.done.toLowerCase() === 'true') ||
                    (pullStatus === 'success' || pullStatus === 'completed' || pullStatus === 'ready');
                const httpStatus = isCompleted ? 200 : 202;

                return new Response(
                    JSON.stringify({
                        status: isCompleted ? 'completed' : 'pulling',
                        model: modelName,
                        message: isCompleted ? 'Model pull completed' : 'Model pull accepted by Ollama',
                        mcp_task_id,
                        context: {
                            task_id: mcp_task_id,
                            model: modelName,
                            requested_at: new Date().toISOString()
                        }
                    }),
                    { status: httpStatus, headers: { 'Content-Type': 'application/json' } }
                );
            } catch (error) {
                logger.warn({ component: 'EMBED', model: modelName ?? null, error: String(error), elapsed_ms: typeof startTs === 'number' ? Date.now() - startTs : null }, 'Ollama unreachable, fallback to synthetic');
                return new Response(
                    JSON.stringify({
                        status: 'unavailable',
                        fallback: 'synthetic',
                        message: 'Ollama service unreachable',
                        error: String(error),
                        error_code: 'ollama_unavailable',
                        context: { tried: modelName, requested_at: new Date().toISOString(), error_details: String(error) }
                    }),
                    { status: 503, headers: { 'Content-Type': 'application/json' } }
                );
            }
        } catch (error) {
            logger.error({ component: 'EMBED', error: String(error) }, 'Error in /embed/ollama/pull');
            return new Response(
                JSON.stringify({ error: 'Internal server error', error_code: 'internal_error', message: String(error) }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    });

    /**
     * GET /embed/ollama/list
     * List installed Ollama models with 30s cache
     */
    app.get('/embed/ollama/list', async () => {
        try {
            // Test seam: if tests injected tags, return them directly and
            // bypass external network call. This prevents flakiness when
            // Ollama isn't available in CI.
            if ((__TEST_ollama as any).tags !== undefined) {
                const tags = typeof (__TEST_ollama as any).tags === 'function' ? await (__TEST_ollama as any).tags() : (__TEST_ollama as any).tags;
                const models = tags.models || tags;
                const result = {
                    models: models.map((m: any) => ({ name: m.name || m, size: m.size || 0, modified_at: m.modified_at || null })),
                    count: models.length,
                    ollama_url: baseUrl,
                    context: { generated_at: new Date().toISOString(), ollama_url: baseUrl }
                };
                // Invalidate cache and serve fresh data
                cache.delete('ollama_list');
                setCache('ollama_list', result, 30000);
                logger.info({ component: 'EMBED', count: models.length }, 'Retrieved Ollama model list (test seam)');
                return new Response(JSON.stringify({ ...result, cached: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            // Check cache first (30s TTL)
            const cached = getCache('ollama_list');
            if (cached) {
                return new Response(
                    JSON.stringify({ ...cached, cached: true }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }

            try {
                const response = await retryFetch(`${baseUrl}/api/tags`, {}, 3, DEFAULT_TIMEOUT_MS, DEFAULT_BACKOFF_MS);

                if (!response.ok) {
                    throw new Error(`Ollama API returned ${response.status}`);
                }

                const data = await response.json();
                const models = data.models || [];

                const result = {
                    models: models.map((m: any) => ({
                        name: m.name,
                        size: m.size,
                        modified_at: m.modified_at
                    })),
                    count: models.length,
                    ollama_url: baseUrl,
                    context: {
                        generated_at: new Date().toISOString(),
                        ollama_url: baseUrl
                    }
                };

                // Cache for 30s
                setCache('ollama_list', result, 30000);

                logger.info({ component: 'EMBED', count: models.length }, 'Retrieved Ollama model list');

                return new Response(
                    JSON.stringify({ ...result, cached: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            } catch (error) {
                logger.warn({ component: 'EMBED', error: String(error) }, 'Ollama unavailable');
                return new Response(
                    JSON.stringify({
                        models: [],
                        error: 'ollama_unavailable',
                        error_code: 'ollama_unavailable',
                        fallback: 'synthetic',
                        message: 'Ollama service unreachable',
                        url: baseUrl,
                        context: { ollama_url: baseUrl, timestamp: new Date().toISOString() }
                    }),
                    { status: 503, headers: { 'Content-Type': 'application/json' } }
                );
            }
        } catch (error) {
            logger.error({ component: 'EMBED', error: String(error) }, 'Error in /embed/ollama/list');
            return new Response(
                JSON.stringify({
                    error: 'internal_error',
                    error_code: 'internal_error',
                    message: String(error),
                    context: { timestamp: new Date().toISOString(), path: '/embed/ollama/list' }
                }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    });

    /**
     * POST /embed/ollama/delete
     * Delete an Ollama model (idempotent)
     */
    app.post('/embed/ollama/delete', async (req: Request, ctx: any) => {
        try {
            // Prefer parsed body from server middleware when available
            let body: any = (ctx && (ctx as any).body) ? (ctx as any).body : undefined;
            if (!body) {
                try {
                    body = await req.clone().json();
                } catch (e) {
                    body = undefined;
                }
            }
            const { model } = body || {};

            if (!model || typeof model !== 'string') {
                return new Response(
                    JSON.stringify({
                        error: 'model required',
                        error_code: 'invalid_request',
                        message: 'Model name required',
                        context: { timestamp: new Date().toISOString(), path: '/embed/ollama/delete' }
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            if (!isValidModelName(model)) {
                return new Response(
                    JSON.stringify({
                        error: 'Invalid model name',
                        error_code: 'invalid_model',
                        message: 'Model name contains invalid characters',
                        context: { timestamp: new Date().toISOString(), path: '/embed/ollama/delete', model }
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            // Check if model is active in models.yml or sector models
            const embeddingInfo = await getEmbeddingInfo();
            let isActiveModel = embeddingInfo.kind === 'ollama' && embeddingInfo.model === model;
            let affectedSectors: string[] = [];

            // Check if model is used in router_cpu sector models
            if (embeddingInfo.provider === 'router_cpu' && embeddingInfo.sector_models) {
                // Collect affected sectors that use this model
                affectedSectors = Object.entries(embeddingInfo.sector_models)
                    .filter(([sector, sectorModel]) => sectorModel === model)
                    .map(([sector]) => sector);

                if (affectedSectors.length > 0) {
                    isActiveModel = true;
                    logger.warn({
                        component: 'EMBED',
                        model,
                        affected_sectors: affectedSectors,
                        mode: 'router_cpu'
                    }, `Deleting router-active model - embeddings for ${affectedSectors.join(', ')} sectors may fallback`);
                }
            } else if (isActiveModel) {
                logger.warn({ component: 'EMBED', model }, 'Deleting active model - embedding may fail');
            }

            try {
                // Support a test seam for delete as well to avoid relying on
                // a running Ollama instance in unit tests.
                if ((__TEST_ollama as any).delete) {
                    const out = typeof (__TEST_ollama as any).delete === 'function' ? await (__TEST_ollama as any).delete(model) : (__TEST_ollama as any).delete;
                    // Invalidate cache so list returns fresh results
                    cache.delete('ollama_list');
                    cache.delete('ollama_status');
                    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }

                const response = await retryFetch(
                    `${baseUrl}/api/delete`,
                    {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: model })
                    },
                    3, DEFAULT_TIMEOUT_MS, DEFAULT_BACKOFF_MS
                );

                // Idempotent: 404 means already deleted, treat as success
                if (response.status === 404 || response.ok) {
                    logger.info({ component: 'EMBED', model }, 'Model deleted (or already absent)');

                    // Invalidate list and status caches
                    cache.delete('ollama_list');
                    cache.delete('ollama_status');

                    const successResponse: any = { status: 'deleted', model };
                    if (isActiveModel) {
                        if (affectedSectors.length > 0) {
                            successResponse.warning = 'router_model_deleted';
                            successResponse.affected_sectors = affectedSectors;
                        } else {
                            successResponse.warning = 'deleted_active_model';
                        }
                    }

                    return new Response(
                        JSON.stringify(successResponse),
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    );
                }

                const errorText = await response.text();
                return new Response(
                    JSON.stringify({
                        error: 'Failed to delete model',
                        error_code: 'delete_failed',
                        message: `Failed to delete model: ${response.statusText}`,
                        context: { status: response.status, detail: errorText }
                    }),
                    { status: response.status, headers: { 'Content-Type': 'application/json' } }
                );
            } catch (error) {
                logger.warn({ component: 'EMBED', model, error: String(error) }, 'Ollama unreachable for delete');
                return new Response(
                    JSON.stringify({
                        error: 'Ollama service unreachable',
                        error_code: 'ollama_unavailable',
                        message: 'Ollama service unreachable',
                        detail: String(error),
                        context: { tried: model, timestamp: new Date().toISOString() }
                    }),
                    { status: 503, headers: { 'Content-Type': 'application/json' } }
                );
            }
        } catch (error) {
            logger.error({ component: 'EMBED', error: String(error) }, 'Error in /embed/ollama/delete');
            return new Response(
                JSON.stringify({
                    error: 'internal_error',
                    error_code: 'internal_error',
                    message: String(error),
                    context: { timestamp: new Date().toISOString(), path: '/embed/ollama/delete' }
                }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    });

    /**
     * GET /embed/ollama/status
     * Health check and registry info with 10s cache
     */
    app.get('/embed/ollama/status', async () => {
        try {
            // Check cache first (10s TTL)
            const cached = getCache('ollama_status');
            if (cached) {
                return new Response(
                    JSON.stringify({ ...cached, cached: true }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }

            try {
                const health = await getOllamaHealth();
                // Uses getOllamaHealth with built-in retries for robustness
                // Get active embedding info
                const embeddingInfo = await getEmbeddingInfo();

                if (health === null) {
                    // Not using Ollama provider
                    const result = {
                        available: false,
                        ollama_available: false,
                        ollama_version: 'unknown',
                        models_loaded: 0,
                        status: 'unavailable',
                        url: baseUrl,
                        active_provider: embeddingInfo.kind,
                        active_model: embeddingInfo.kind === 'ollama' ? embeddingInfo.model : undefined,
                        message: 'Not using Ollama provider',
                        error: 'Ollama not configured as active provider',
                        error_code: 'ollama_unavailable',
                        context: { timestamp: new Date().toISOString() }
                    };
                    // Cache for 10s
                    setCache('ollama_status', result, 10000);
                    return new Response(
                        JSON.stringify({ ...result, cached: false }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    );
                }

                let result: any = {
                    available: health.available,
                    ollama_available: health.available,
                    ollama_version: health.version || 'unknown',
                    models_loaded: health.models_loaded || 0,
                    status: health.available ? 'healthy' : 'unavailable',
                    url: baseUrl,
                    active_provider: embeddingInfo.kind,
                    active_model: embeddingInfo.kind === 'ollama' ? embeddingInfo.model : undefined,
                    error_code: health.available ? undefined : 'ollama_unavailable',
                    context: health.available ? undefined : { timestamp: new Date().toISOString(), url: baseUrl }
                };

                if (!health.available) {
                    const errorMessage = health.error || 'ollama_unavailable';
                    const errorText = health.error ? `Ollama unavailable: ${health.error}` : 'Ollama service unreachable';
                    result.message = errorText;
                    result.error = errorMessage;
                }

                // Cache for 10s (status is lightweight)
                setCache('ollama_status', result, 10000);

                if (health.available) {
                    logger.info({ component: 'EMBED', models_count: health.models_loaded || 0 }, 'Ollama status healthy');
                } else {
                    logger.warn({ component: 'EMBED', error: health.error || 'unknown' }, 'Ollama unavailable for status');
                }

                return new Response(
                    JSON.stringify({ ...result, cached: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            } catch (error) {
                logger.warn({ component: 'EMBED', error: String(error) }, 'Ollama status check failed');

                // Even if call fails, return a consistent object with availability
                const embeddingInfo = await getEmbeddingInfo();
                const result = {
                    available: false,
                    ollama_available: false,
                    ollama_version: 'unknown',
                    models_loaded: 0,
                    status: 'unavailable',
                    url: baseUrl,
                    active_provider: embeddingInfo.kind,
                    message: 'Ollama service unreachable',
                    error: String(error),
                    error_code: 'ollama_unavailable',
                    error_detail: String(error),
                    context: { timestamp: new Date().toISOString() }
                };

                return new Response(JSON.stringify(result), { status: 503, headers: { 'Content-Type': 'application/json' } });
            }
        } catch (error) {
            logger.error({ component: 'EMBED', error: String(error) }, 'Error in /embed/ollama/status');
            const embeddingInfo = await getEmbeddingInfo();
            return new Response(
                JSON.stringify({
                    error: 'internal_error',
                    error_code: 'internal_error',
                    message: String(error),
                    url: baseUrl,
                    active_provider: embeddingInfo.kind
                }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
        }
    });

    /**
     * GET /embed/config
     * Get current embedding configuration with optional detailed metrics
     * Supports cached responses (10s TTL) for performance
     */
    app.get('/embed/config', async (req: Request) => {
        try {
            const url = new URL(req.url);
            const detailed = url.searchParams.get('detailed') === 'true';
            const cacheKey = detailed ? 'embed_config_detailed' : 'embed_config_basic';

            // Check cache first (10s TTL)
            const cached = getCache(cacheKey);
            if (cached) {
                return new Response(
                    JSON.stringify({ ...cached, cached: true }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }

            // Get current configuration
            const embeddingInfo = await getEmbeddingInfo();

            let result: any = {
                kind: embeddingInfo.kind,  // Canonical provider field (treat 'provider' as deprecated alias)
                provider: embeddingInfo.provider,  // Explicit provider field
                dimensions: embeddingInfo.dimensions,
                mode: embeddingInfo.mode,
                // Explicit batching field: always present regardless of provider, matches OM_EMBED_MODE
                batch_mode: embeddingInfo.mode,
                batch_support: embeddingInfo.batch_support,
                advanced_parallel: embeddingInfo.advanced_parallel,
                embed_delay_ms: embeddingInfo.embed_delay_ms,
                // Distinct SIMD fields: global affects all providers, router affects router_cpu only
                // Runtime-aware flags from getEmbeddingInfo() (reflects POST updates)
                simd_global_enabled: embeddingInfo.simd_global_enabled,
                simd_router_enabled: embeddingInfo.simd_router_enabled,
                // Legacy alias for backward compatibility (deprecated, will be removed)
                simd_enabled: env.global_simd_enabled,
                context: { timestamp: new Date().toISOString() }
            };

            // Add provider-specific fields
            if (embeddingInfo.provider === 'router_cpu') {
                result.router_enabled = embeddingInfo.router_enabled;

                result.fallback_enabled = embeddingInfo.fallback_enabled;
                result.cache_ttl_ms = embeddingInfo.cache_ttl_ms;
                result.sector_models = embeddingInfo.sector_models;
                result.performance = embeddingInfo.performance;
                result.ollama_required = embeddingInfo.ollama_required;
            } else if (embeddingInfo.provider === 'ollama') {
                result.url = embeddingInfo.url;
                result.models = embeddingInfo.models;
                result.keep_alive = embeddingInfo.keep_alive;
                result.models_config = embeddingInfo.models_config;
                result.num_parallel = embeddingInfo.num_parallel;
                result.num_gpu = embeddingInfo.num_gpu;
                result.auto_pull = embeddingInfo.auto_pull;
                result.multimodal_enabled = embeddingInfo.multimodal_enabled;
                result.management_api = embeddingInfo.management_api;
            } else if (embeddingInfo.provider === 'openai') {
                result.configured = embeddingInfo.configured;
                result.base_url = embeddingInfo.base_url;
                result.model_override = embeddingInfo.model_override;
                result.batch_api = embeddingInfo.batch_api;
                result.models = embeddingInfo.models;
            } else if (embeddingInfo.provider === 'gemini') {
                result.configured = embeddingInfo.configured;
                result.batch_api = embeddingInfo.batch_api;
                result.model = embeddingInfo.model;
            } else if (embeddingInfo.provider === 'local') {
                result.configured = embeddingInfo.configured;
                result.path = embeddingInfo.path;
            } else {
                result.configured = embeddingInfo.configured;
                result.type = embeddingInfo.type;
            }

            // Add performance metrics if detailed requested
            if (detailed) {
                result.performance_metrics = {
                    ollama_status: await getOllamaHealth(),
                    cache_stats: {
                        config_cache_size: cache.size
                    }
                };
                result.system_info = {
                    available_providers: ['openai', 'gemini', 'ollama', 'local', 'router_cpu', 'synthetic'],
                    current_system_tier: process.env.OM_TIER || 'hybrid',
                    vector_dimensions_configured: embeddingInfo.dimensions
                };
            }

            // Cache configuration for 10s
            setCache(cacheKey, result, 10000);

            logger.info({ component: 'EMBED', provider: result.kind, detailed }, 'Embedding configuration retrieved');

            return new Response(
                JSON.stringify({ ...result, cached: false }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        } catch (error) {
            logger.error({ component: 'EMBED', error: String(error) }, 'Error in /embed/config GET');
            return new Response(
                JSON.stringify({
                    error: 'internal_error',
                    error_code: 'internal_error',
                    message: String(error),
                    context: { timestamp: new Date().toISOString(), path: '/embed/config' }
                }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    });

    /**
     * POST /embed/config
     * Update embedding configuration at runtime (e.g., mode switching)
     * Supports changing embedding provider and parameters
     */
    app.post('/embed/config', async (req: Request, ctx: any) => {
        try {
            // Authentication and authorization for POST requests is handled by
            // the global `authenticate_api_request` middleware. Avoid handling
            // auth here to prevent duplicate or inconsistent checks (e.g. hashed
            // API keys) — rely on the centralized middleware for uniform behavior.

            // Prefer parsed body from server middleware when available
            let body: any = (ctx && (ctx as any).body) ? (ctx as any).body : undefined;
            if (!body) {
                try {
                    body = await req.clone().json();
                } catch (e) {
                    body = undefined;
                }
            }

            // Destructuring: support both embed_mode and legacy mode field
            const { provider, embed_mode, mode, router_simd_enabled, router_fallback_enabled, global_simd_enabled, ...rest } = body || {};

            // Determine effective mode from either embed_mode or legacy mode field
            const effectiveMode = embed_mode ?? mode;

            // Require provider only when we're actually changing providers, not just embed_mode
            if (provider === undefined && effectiveMode === undefined && global_simd_enabled === undefined) {
                return new Response(
                    JSON.stringify({
                        error: 'invalid_request',
                        error_code: 'invalid_request',
                        message: 'Specify at least one of: provider (openai, gemini, ollama, local, router_cpu, synthetic), embed_mode ("simple", "advanced"), or global_simd_enabled (boolean)',
                        context: { timestamp: new Date().toISOString(), path: '/embed/config' }
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            // Validate effective mode if provided
            if (effectiveMode !== undefined && !['simple', 'advanced'].includes(effectiveMode)) {
                return new Response(
                    JSON.stringify({
                        error: 'Invalid embed_mode',
                        error_code: 'invalid_embed_mode',
                        message: 'embed_mode must be "simple" or "advanced"',
                        context: { timestamp: new Date().toISOString(), embed_mode: effectiveMode, path: '/embed/config' }
                    }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } }
                );
            }

            // Validate provider if provided
            if (provider !== undefined) {
                const validProviders = ['openai', 'gemini', 'ollama', 'local', 'router_cpu', 'synthetic'];
                if (!validProviders.includes(provider)) {
                    return new Response(
                        JSON.stringify({
                            error: 'Invalid provider',
                            error_code: 'invalid_provider',
                            message: `Invalid provider "${provider}": provider must be one of: ${validProviders.join(', ')}`,
                            context: { timestamp: new Date().toISOString(), provider: provider, path: '/embed/config' }
                        }),
                        { status: 400, headers: { 'Content-Type': 'application/json' } }
                    );
                }
            }

            // Invalidate configuration cache to force fresh retrieval
            cache.delete('embed_config_basic');
            cache.delete('embed_config_detailed');

            // Before applying runtimeUpdates, call getEmbeddingInfo to compute previous_provider/previous_mode from the current runtime configuration
            const embeddingInfoBefore = await getEmbeddingInfo();
            const previous_provider = embeddingInfoBefore.provider;
            const previous_mode = embeddingInfoBefore.mode;

            logger.info({
                component: 'EMBED',
                previous_provider,
                new_provider: provider,
                embed_mode,
                updates: { router_simd_enabled, router_fallback_enabled, global_simd_enabled, ...rest }
            }, 'Updating embedding configuration');

            // Build runtime config updates
            const runtimeUpdates: any = {};
            if (provider !== undefined) {
                runtimeUpdates.embed_kind = provider;
                if (provider === 'router_cpu') {
                    runtimeUpdates.router_simd_enabled = router_simd_enabled;
                    runtimeUpdates.router_fallback_enabled = router_fallback_enabled;
                }
            }
            if (effectiveMode !== undefined) {
                runtimeUpdates.embed_mode = effectiveMode;
            }
            // When global_simd_enabled is present in request body, map it to a single runtime field
            if (global_simd_enabled !== undefined) {
                runtimeUpdates.global_simd_enabled = global_simd_enabled;
            }

            // Apply runtime configuration changes for things that are safe to
            // update without a restart (e.g., embed_mode or runtime toggles).
            // For provider changes (which require a restart) avoid mutating
            // the runtime configuration so tests and callers do not observe
            // partial state changes before a full restart.
            if (provider === undefined) {
                updateRuntimeConfig(runtimeUpdates);
            } else {
                // Only allow non-provider runtime updates to be applied
                const safeUpdates: any = { ...runtimeUpdates };
                delete safeUpdates.embed_kind;
                if (Object.keys(safeUpdates).length > 0) updateRuntimeConfig(safeUpdates);
            }

            // After applying non-provider overrides, recompute the effective provider and mode
            // (or trust that provider changes are restart-gated and note that explicitly)
            const embeddingInfoAfter = await getEmbeddingInfo();

            // Build response message dynamically
            let message = '';
            const updatesApplied: any = {};

            if (provider !== undefined) {
                message += `Provider updated to ${provider}`;
                updatesApplied.provider = provider;
                if (provider === 'router_cpu') {
                    updatesApplied.router_simd_enabled = router_simd_enabled;
                    updatesApplied.router_fallback_enabled = router_fallback_enabled;
                }
            }

            if (effectiveMode !== undefined) {
                if (message) message += ', ';
                message += `embed_mode updated to ${effectiveMode}`;
                updatesApplied.embed_mode = effectiveMode;
            }

            if (global_simd_enabled !== undefined) {
                if (message) message += ', ';
                message += `global SIMD ${global_simd_enabled ? 'enabled' : 'disabled'}`;
                updatesApplied.global_simd_enabled = global_simd_enabled;
            }

            // Determine if restart is required: only when provider changes actually require restart
            // Batch-mode-only changes do not require restart
            const restartRequired = provider !== undefined;

            return new Response(
                JSON.stringify({
                    status: 'configuration_updated',
                    message,
                    previous_provider,
                    new_provider: provider ?? embeddingInfoAfter.provider,
                    previous_mode, // Legacy field for compatibility
                    new_mode: effectiveMode ?? embeddingInfoAfter.mode, // Legacy field for compatibility
                    updates_applied: updatesApplied,
                    restart_required: restartRequired,
                    context: {
                        distinction_note: 'Note: embed_kind selects provider (e.g., router_cpu); embed_mode controls batching (simple/advanced) via OM_EMBED_MODE env var. Use "provider" field for future compatibility.',
                        timestamp: new Date().toISOString(),
                        requested_provider: provider,
                        requested_embed_mode: effectiveMode,
                        current_provider: provider ?? embeddingInfoAfter.provider,
                        current_embed_mode: effectiveMode ?? embeddingInfoAfter.mode
                    }
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );

        } catch (error) {
            logger.error({ component: 'EMBED', error: String(error) }, 'Error in /embed/config POST');
            return new Response(
                JSON.stringify({
                    error: 'internal_error',
                    error_code: 'internal_error',
                    message: String(error),
                    context: { timestamp: new Date().toISOString(), path: '/embed/config' }
                }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    });
}
