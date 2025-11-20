export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'

export const getHeaders = () => {
    const apiKey = process.env.NEXT_PUBLIC_API_KEY
    return {
        'Content-Type': 'application/json',
        ...(apiKey && { 'x-api-key': apiKey }),
    }
}

// Server-only headers helper that can include the admin key (kept out of client bundle)
export const getServerHeaders = () => {
  const apiKey = process.env.NEXT_PUBLIC_API_KEY
  return {
    'Content-Type': 'application/json',
    ...(apiKey && { 'x-api-key': apiKey }),
    ...(process.env.OM_ADMIN_API_KEY_PLAIN && { 'x-admin-key': process.env.OM_ADMIN_API_KEY_PLAIN }),
  }
}

/**
 * EmbeddingProvider: Selects the backend for generating embeddings.
 * Maps to OM_EMBED_KIND environment variable. Each provider has different
 * capabilities, costs, and requirements (e.g., router_cpu requires Ollama).
 */
export type EmbeddingProvider =
  | 'synthetic' // Fast, no-cost, deterministic embeddings for testing/demo
  | 'openai' // Cloud API with token limits and cost
  | 'gemini' // Google's embedding API
  | 'ollama' // Local models via Ollama
  | 'local' // Custom/local embedding models
  | 'router_cpu'; // CPU-optimized sector routing (requires Ollama)

/**
 * FutureEmbeddingProvider: Planned providers not yet implemented by the backend.
 * Values like "moe-cpu" are intentionally not supported by the current backend and
 * /embed/config will reject them until a future phase implements full MoE support
 * including transformers.js 3.x and IBM/Liquid MoE integration.
 */
export type FutureEmbeddingProvider =
  | 'moe-cpu'; // FUTURE: Requires transformers.js 3.x + IBM/Liquid MoE integration

/**
 * EmbeddingBatchMode: Controls how multiple embedding requests are batched.
 * Maps to OM_EMBED_MODE environment variable for processing strategy.
 */
export type EmbeddingBatchMode =
  | 'simple' // Single embedding call per query (faster, less nuanced)
  | 'advanced'; // Per-sector parallel embeddings (slower, more accurate)

// Legacy alias for backward compatibility - do not add new values here
export type EmbeddingMode = EmbeddingProvider;

// Embedding API Types and Functions
export interface EmbeddingModeConfig {
  // IMPORTANT: 'kind' field is deprecated, use 'provider' instead
  kind: string;
  provider: EmbeddingProvider; // New field for provider selection
  dimensions: number;
  mode: string;
  batch_mode?: string; // Explicit backend field for batch mode (always present)
  batchMode: EmbeddingBatchMode; // New field for batch mode
  batch_support: boolean;
  advanced_parallel: boolean;
  embed_delay_ms: number;
  // Router-specific fields: only present when provider === 'router_cpu'
  router_enabled?: boolean;
  simd_enabled?: boolean; // Legacy alias for backward compatibility
  simd_global_enabled?: boolean; // Global SIMD affects all providers
  simd_router_enabled?: boolean; // Router SIMD affects router_cpu only
  fallback_enabled?: boolean;
  cache_ttl_ms?: number;
  sector_models?: Record<string, string>;
  performance?: {
    expected_p95_ms: number;
    expected_simd_improvement: number;
    memory_usage_gb: number;
  };
  ollama_required?: boolean;
}

export interface EmbeddingConfig extends EmbeddingModeConfig {
  // Additional fields for UI state management
  cached?: boolean;

  // Detailed response fields (when detailed=true)
  performance_metrics?: {
    ollama_status: any; // Can be null if Ollama not available
    cache_stats: {
      config_cache_size: number;
    };
  };
  system_info?: {
    available_providers: EmbeddingProvider[];
    current_system_tier: string;
    vector_dimensions_configured: number;
  };
}

// Client-side cache for configuration to reduce API calls
let configCache: EmbeddingConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 10000; // 10 seconds, matches server /embed/config cache TTL

/**
 * Helper function to validate provider values without casting
 * Only narrow to EmbeddingProvider when value is actually valid
 */
function isValidProvider(value: string | undefined): value is EmbeddingProvider {
  return value === 'synthetic' ||
         value === 'openai' ||
         value === 'gemini' ||
         value === 'ollama' ||
         value === 'local' ||
         value === 'router_cpu';
}

/**
 * Helper function to validate batch mode values against EmbeddingBatchMode union
 * If not valid, returns default 'simple'
 */
function validateBatchMode(value: string | undefined): EmbeddingBatchMode | undefined {
  if (value === 'simple' || value === 'advanced') {
    return value;
  }
  return undefined; // Will fall back to default 'simple'
}

/**
 * Get embedding configuration with client-side caching
 */
export async function getEmbeddingConfig(detailed = false): Promise<EmbeddingConfig> {
  const now = Date.now();
  if (configCache && (now - configCacheTime) < CONFIG_CACHE_TTL) {
    return configCache;
  }

  const url = detailed ? `${API_BASE_URL}/embed/config?detailed=true` : `${API_BASE_URL}/embed/config`;
  try {
    const response = await fetch(url, { headers: getHeaders() });

    if (!response.ok) {
      throw new Error(`Failed to fetch embedding config: ${response.status}`);
    }

    // Type the parsed JSON as Partial<EmbeddingConfig> to handle potentially missing fields
    const parsedConfig = await response.json() as Partial<EmbeddingConfig>;

    // Construct strongly typed object with safe defaults
    const unifiedConfig: EmbeddingConfig = {
      // Required fields with safe defaults based on known constraints
      kind: parsedConfig.kind || 'synthetic',
      // Prefer parsedConfig.provider first and only fall back to parsedConfig.kind when provider is undefined
      // Ensure proper type safety - narrow only when value is a known provider
      provider: isValidProvider(parsedConfig.provider) ? parsedConfig.provider :
                (parsedConfig.provider ? 'synthetic' : (isValidProvider(parsedConfig.kind) ? parsedConfig.kind : 'synthetic')),
      dimensions: parsedConfig.dimensions || 256,
      mode: parsedConfig.mode || 'simple',
      // Validate batchMode computation against EmbeddingBatchMode union
      batchMode: validateBatchMode(parsedConfig.batch_mode) || validateBatchMode(parsedConfig.batchMode) || validateBatchMode(parsedConfig.mode) || 'simple',
      batch_support: parsedConfig.batch_support || false,
      advanced_parallel: parsedConfig.advanced_parallel || false,
      embed_delay_ms: parsedConfig.embed_delay_ms || 0,

      // Required SIMD fields: backend should always include both
      simd_global_enabled: parsedConfig.simd_global_enabled ?? true,
      simd_router_enabled: parsedConfig.simd_router_enabled ?? true,

      // Router-specific fields: may be undefined for non-router providers
      router_enabled: parsedConfig.router_enabled,
      fallback_enabled: parsedConfig.fallback_enabled,
      cache_ttl_ms: parsedConfig.cache_ttl_ms,
      sector_models: parsedConfig.sector_models,
      performance: parsedConfig.performance,
      ollama_required: parsedConfig.ollama_required,

      // Additional optional fields
      cached: parsedConfig.cached,
      performance_metrics: parsedConfig.performance_metrics,
      system_info: parsedConfig.system_info,
    };

    configCache = unifiedConfig;
    configCacheTime = now;

    // Assert that canonical SIMD fields are present to surface misconfigurations immediately
    if (process.env.NODE_ENV === 'development') {
      if (unifiedConfig.simd_global_enabled === undefined) {
        console.warn('[DEV] Warning: /embed/config is missing required field "simd_global_enabled". Backend should always include this field.');
      }
      if (unifiedConfig.simd_router_enabled === undefined) {
        console.warn('[DEV] Warning: /embed/config is missing required field "simd_router_enabled". Backend should always include this field.');
      }
    }

    // Add logging for SIMD config loaded for debugging
    console.log('SIMD config loaded:', { global: unifiedConfig.simd_global_enabled, router: unifiedConfig.simd_router_enabled });

    return unifiedConfig;
  } catch (error) {
    // For robustness, provide a minimal safe fallback config instead of throwing
    console.warn('Failed to fetch embedding config, using fallback:', error);
    const fallbackConfig: EmbeddingConfig = {
      // Required fields (never undefined)
      kind: 'synthetic',
      provider: 'synthetic',
      dimensions: 256,
      mode: 'simple',
      batchMode: 'simple' as EmbeddingBatchMode,
      batch_support: false,
      advanced_parallel: false,
      embed_delay_ms: 0,

      // Router-specific fields (explicitly setting defaults for clarity)
      router_enabled: false,
      simd_global_enabled: false,
      simd_router_enabled: false,
      // Legacy alias for backward compatibility
      simd_enabled: false,
      fallback_enabled: false,
      cache_ttl_ms: 30000,
      sector_models: {},
      performance: {
        expected_p95_ms: 100,
        expected_simd_improvement: 0,
        memory_usage_gb: 2.0
      },
      ollama_required: false,
      cached: false
    };
    configCache = fallbackConfig;
    configCacheTime = now;
    return fallbackConfig;
  }
}

/**
 * Update embedding provider (e.g., 'router_cpu'). Does not change batching mode.
 */
export async function updateEmbeddingProvider(
  provider: string,
  options?: { global_simd_enabled?: boolean; router_simd_enabled?: boolean; router_fallback_enabled?: boolean }
): Promise<{ success: boolean; message: string; restart_required: boolean; prev_provider: string; new_provider: string }> {
  const body: any = { provider };
  if (options?.global_simd_enabled !== undefined) {
    body.global_simd_enabled = options.global_simd_enabled;
  }
  if (options?.router_simd_enabled !== undefined) {
    body.router_simd_enabled = options.router_simd_enabled;
  }
  if (options?.router_fallback_enabled !== undefined) {
    body.router_fallback_enabled = options.router_fallback_enabled;
  }

  const response = await fetch(`${API_BASE_URL}/embed/config`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `Failed to update embedding provider: ${response.status}`);
  }

  const result = await response.json();

  // Invalidate cache on successful update
  configCache = null;
  configCacheTime = 0;

  const newProvider = result.new_provider || result.new_mode;
  const previousProvider = result.previous_provider || result.previous_mode;

  return {
    success: result.status === 'configuration_updated',
    message: result.message || 'Provider updated',
    restart_required: result.restart_required || false,
    prev_provider: previousProvider,
    new_provider: newProvider,
  };
}

/**
 * Update embedding batching mode ('simple' or 'advanced'). Does not change provider.
 */
export async function updateEmbeddingBatchMode(
  embed_mode: 'simple' | 'advanced'
): Promise<{ success: boolean; message: string; restart_required: boolean }> {
  const body = { provider: undefined, embed_mode };

  const response = await fetch(`${API_BASE_URL}/embed/config`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `Failed to update embedding batch mode: ${response.status}`);
  }

  const result = await response.json();

  // Invalidate cache on successful update
  configCache = null;
  configCacheTime = 0;

  return {
    success: result.status === 'configuration_updated',
    message: result.message || 'Batch mode updated',
    restart_required: result.restart_required || false,
  };
}

/**
 * Type guard to check if configuration is for router_cpu provider
 */
export function isRouterConfig(config: EmbeddingConfig): config is EmbeddingConfig & {
  provider: 'router_cpu';
  router_enabled: true;
  sector_models: Record<string, string>;
  cache_ttl_ms: number;
  performance: { expected_p95_ms: number; expected_simd_improvement: number; memory_usage_gb: number };
  ollama_required: true;
} {
  return config.provider === 'router_cpu' && config.router_enabled === true;
}

/**
 * Provider options for UI selection
 * Note: Only the listed providers are currently selectable in the dashboard UI.
 * Future providers like "moe-cpu" require backend implementation of full MoE support.
 */
export const PROVIDER_OPTIONS: Array<{
  value: EmbeddingProvider;
  label: string;
  description: string;
  icon: string;
  color: string;
  requires?: string[];
}> = [
  {
    value: 'synthetic',
    label: 'Synthetic',
    description: 'Fast, deterministic embeddings for testing and demo',
    icon: '🔧',
    color: 'gray',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    description: 'Cloud API with high-quality embeddings and token limits',
    icon: '☁️',
    color: 'blue',
    requires: ['openai_key'],
  },
  {
    value: 'gemini',
    label: 'Gemini',
    description: 'Google\'s embedding API with competitive performance',
    icon: '🤖',
    color: 'green',
    requires: ['gemini_key'],
  },
  {
    value: 'ollama',
    label: 'Ollama',
    description: 'Local models via Ollama for private, offline embeddings',
    icon: '🏠',
    color: 'orange',
    requires: ['ollama'],
  },
  {
    value: 'local',
    label: 'Local Models',
    description: 'Custom local embedding models',
    icon: '💻',
    color: 'purple',
  },
  {
    value: 'router_cpu',
    label: 'Router CPU',
    description: 'Single-expert-per-sector CPU router over Ollama embeddings, not full MoE (multi-expert deferred to later phase)',
    icon: '🚀',
    color: 'red',
    requires: ['ollama'],
  },
];

/**
 * Batch mode options for UI selection
 */
export const BATCH_MODE_OPTIONS: Array<{
  value: EmbeddingBatchMode;
  label: string;
  description: string;
}> = [
  {
    value: 'simple',
    label: 'Simple Batching',
    description: 'Single embedding call per query (faster, less nuanced)',
  },
  {
    value: 'advanced',
    label: 'Advanced Parallel',
    description: 'Per-sector parallel embeddings (more accurate, higher latency)',
  },
];

// Backward compatibility alias
export const updateEmbeddingMode = updateEmbeddingProvider;

/**
 * Shared interface for embedding telemetry sent to both memory/query and /api/chat endpoints.
 * Include version field to facilitate backend evolution while maintaining backward compatibility.
 */
export interface EmbeddingTelemetryMeta {
  meta_version: number;
  provider: EmbeddingProvider;
  batch_mode: EmbeddingBatchMode;
  // Global SIMD affects all providers
  simd_global_enabled: boolean;
  // Router-specific SIMD (only used when provider === 'router_cpu')
  router_simd_enabled?: boolean;
  fallback_enabled?: boolean;
  sector_models_summary?: number; // Number of sector-to-model mappings for router_cpu
}

/**
 * Helper function to construct telemetry metadata from EmbeddingConfig.
 * Versioned to allow future schema changes with backwards compatibility.
 */
export function buildEmbeddingTelemetry(config: EmbeddingConfig): EmbeddingTelemetryMeta {
  return {
    meta_version: 1,
    provider: config.provider,
    batch_mode: config.batchMode,
    simd_global_enabled: config.simd_global_enabled ?? true,
    ...(config.provider === 'router_cpu' && {
      router_simd_enabled: config.simd_router_enabled ?? true,
      fallback_enabled: config.fallback_enabled ?? true,
      sector_models_summary: Object.keys(config.sector_models || {}).length,
    }),
  };
}
