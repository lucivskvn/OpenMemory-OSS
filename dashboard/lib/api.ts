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

export type EmbeddingMode = 'synthetic' | 'openai' | 'gemini' | 'ollama' | 'local' | 'router_cpu';

// Embedding API Types and Functions
export interface EmbeddingModeConfig {
  kind: string;
  dimensions: number;
  mode: string;
  batch_support: boolean;
  advanced_parallel: boolean;
  embed_delay_ms: number;
  router_enabled?: boolean;
  simd_enabled?: boolean;
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
}

// Client-side cache for configuration to reduce API calls
let configCache: EmbeddingConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 10000; // 10 seconds, matches server /embed/config cache TTL

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

    const config = await response.json();
    configCache = config;
    configCacheTime = now;

    return config;
  } catch (error) {
    // For robustness, provide a minimal safe fallback config instead of throwing
    console.warn('Failed to fetch embedding config, using fallback:', error);
    const fallbackConfig: EmbeddingConfig = {
      kind: 'synthetic',
      dimensions: 256,
      mode: 'simple',
      batch_support: false,
      advanced_parallel: false,
      embed_delay_ms: 0
    };
    configCache = fallbackConfig;
    configCacheTime = now;
    return fallbackConfig;
  }
}

/**
 * Update embedding provider (e.g., 'router_cpu'). For batching (simple/advanced), use embed_mode. Backward compatible with 'mode' field.
 */
export async function updateEmbeddingProvider(
  mode: string,
  options?: { router_simd_enabled?: boolean; router_fallback_enabled?: boolean; embed_mode?: string }
): Promise<{ success: boolean; message: string; restart_required: boolean; prev_provider: string; new_provider: string }> {
  const body: any = { provider: mode }; // Use provider primarily
  if (options?.router_simd_enabled !== undefined) {
    body.router_simd_enabled = options.router_simd_enabled;
  }
  if (options?.router_fallback_enabled !== undefined) {
    body.router_fallback_enabled = options.router_fallback_enabled;
  }
  if (options?.embed_mode !== undefined) {
    body.embed_mode = options.embed_mode;
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

  // Parse provider fields with fallbacks for backward compatibility
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

// Backward compatibility alias
export const updateEmbeddingMode = updateEmbeddingProvider;
