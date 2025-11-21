'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getEmbeddingConfig,
  updateEmbeddingProvider,
  updateEmbeddingBatchMode,
  PROVIDER_OPTIONS,
  BATCH_MODE_OPTIONS,
} from '@/lib/api';

interface OllamaStatus {
  available: boolean;
  ollama_available: boolean;
  ollama_version?: string;
  models_loaded: number;
  status: string;
  url?: string;
  active_provider?: string;
  active_model?: string;
  message?: string;
  error?: string;
}

interface OllamaModelInfo {
  name: string;
  size?: number;
  modified_at?: string;
}

interface EmbeddingConfig {
  provider: string;
  batchMode: string;
  dimensions: number;
  model?: string;
  ollama_required?: boolean;
  performance?: {
    expected_p95_ms: number;
    expected_simd_improvement: number;
    memory_usage_gb: number;
  };
}

export default function EmbeddingDashboardPage() {
  const [config, setConfig] = useState<EmbeddingConfig | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [pullingModel, setPullingModel] = useState(false);
  const [testResult, setTestResult] = useState<string>('');

  // Test interface states
  const [testInput, setTestInput] = useState('');
  const [testLoading, setTestLoading] = useState(false);

  const fetchEmbeddingConfig = useCallback(async () => {
    try {
      const configData = await getEmbeddingConfig(true);
      setConfig({
        provider: configData.provider,
        batchMode: configData.batchMode,
        dimensions: configData.dimensions,
        model: (configData as any).model || (configData as any).active_model,
        ollama_required: configData.ollama_required,
        performance: configData.performance,
      });
    } catch (error) {
      console.error('Failed to fetch embedding config:', error);
    }
  }, []);

  const fetchOllamaStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/embed/ollama/status');
      const data = await res.json();
      setOllamaStatus(data);
    } catch (error) {
      console.error('Failed to fetch Ollama status:', error);
      setOllamaStatus({
        available: false,
        ollama_available: false,
        models_loaded: 0,
        status: 'error',
      });
    }
  }, []);

  const fetchOllamaModels = useCallback(async () => {
    try {
      const res = await fetch('/api/embed/ollama/list');
      const data = await res.json();
      setOllamaModels(data.models || []);
    } catch (error) {
      console.error('Failed to fetch Ollama models:', error);
      setOllamaModels([]);
    }
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([
        fetchEmbeddingConfig(),
        fetchOllamaStatus(),
        fetchOllamaModels(),
      ]);
      setLoading(false);
    };
    loadData();
  }, [fetchEmbeddingConfig, fetchOllamaStatus, fetchOllamaModels]);

  const handleProviderChange = async (newProvider: string) => {
    setUpdating(true);
    try {
      await updateEmbeddingProvider(newProvider);
      await fetchEmbeddingConfig();
      await fetchOllamaStatus();
    } catch (error: any) {
      alert(`Failed to update provider: ${error.message}`);
    } finally {
      setUpdating(false);
    }
  };

  const handleBatchModeChange = async (newMode: string) => {
    setUpdating(true);
    try {
      await updateEmbeddingBatchMode(newMode as 'simple' | 'advanced');
      await fetchEmbeddingConfig();
    } catch (error: any) {
      alert(`Failed to update batch mode: ${error.message}`);
    } finally {
      setUpdating(false);
    }
  };

  const handlePullModel = async (modelName: string) => {
    setPullingModel(true);
    try {
      const res = await fetch('/api/embed/ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName }),
      });
      const result = await res.json();

      if (res.ok) {
        alert(`Started pulling model ${modelName}. Check status for progress.`);
        await fetchOllamaStatus();
        await fetchOllamaModels();
      } else {
        alert(`Failed to pull model: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      alert(`Error pulling model: ${String(error)}`);
    } finally {
      setPullingModel(false);
    }
  };

  const handleTestEmbedding = async () => {
    if (!testInput.trim()) return;

    setTestLoading(true);
    setTestResult('');
    try {
      const res = await fetch('/api/memory/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: testInput.trim(),
          k: 5,
        }),
      });

      const result = await res.json();
      if (res.ok) {
        const matches = result.matches || [];
        const summary =
          matches.length > 0
            ? `Found ${matches.length} matches. First match score: ${(matches[0].score * 100).toFixed(1)}%`
            : 'No matches found for this query.';
        setTestResult(summary);
      } else {
        setTestResult(`Query failed: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      setTestResult(`Error: ${String(error)}`);
    } finally {
      setTestLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy':
      case 'completed':
        return 'text-green-400';
      case 'unavailable':
      case 'error':
        return 'text-red-400';
      case 'pulling':
        return 'text-yellow-400';
      default:
        return 'text-stone-400';
    }
  };

  const getProviderInfo = (provider: string) => {
    return (
      PROVIDER_OPTIONS.find((p) => p.value === provider) || PROVIDER_OPTIONS[0]
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-stone-400">Loading embedding configuration...</div>
      </div>
    );
  }

  const currentProvider = config?.provider || 'synthetic';
  const providerInfo = getProviderInfo(currentProvider);

  return (
    <div className="min-h-screen max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-white text-3xl">Embedding Dashboard</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Current Configuration */}
        <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
          <h2 className="text-xl text-white mb-4">Current Configuration</h2>
          <div className="space-y-4">
            <div className="flex items-center space-x-3">
              <div className="text-stone-400">Provider:</div>
              <div className="flex items-center space-x-2">
                <span>{providerInfo.icon}</span>
                <span className="text-white font-medium">
                  {providerInfo.label}
                </span>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <div className="text-stone-400">Batch Mode:</div>
              <span className="text-white capitalize">
                {config?.batchMode || 'simple'}
              </span>
            </div>
            <div className="flex items-center space-x-3">
              <div className="text-stone-400">Dimensions:</div>
              <span className="text-white">{config?.dimensions || 256}</span>
            </div>
            {config?.model && (
              <div className="flex items-center space-x-3">
                <div className="text-stone-400">Active Model:</div>
                <span className="text-white font-mono text-sm">
                  {config.model}
                </span>
              </div>
            )}
            {config?.performance && (
              <div className="flex items-center space-x-3">
                <div className="text-stone-400">Expected P95:</div>
                <span className="text-white">
                  {config.performance.expected_p95_ms}ms
                </span>
              </div>
            )}
          </div>
        </div>

        {/* System Status */}
        <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
          <h2 className="text-xl text-white mb-4">System Status</h2>
          <div className="space-y-4">
            {ollamaStatus && (
              <>
                <div className="flex items-center space-x-3">
                  <div className="text-stone-400">Ollama:</div>
                  <div className="flex items-center space-x-2">
                    <div
                      className={`w-2 h-2 rounded-full ${ollamaStatus.available ? 'bg-green-500' : 'bg-red-500'}`}
                    ></div>
                    <span className={getStatusColor(ollamaStatus.status)}>
                      {ollamaStatus.status}
                    </span>
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="text-stone-400">Models Loaded:</div>
                  <span className="text-white">
                    {ollamaStatus.models_loaded || 0}
                  </span>
                </div>
                {ollamaStatus.ollama_version && (
                  <div className="flex items-center space-x-3">
                    <div className="text-stone-400">Version:</div>
                    <span className="text-white font-mono text-sm">
                      {ollamaStatus.ollama_version}
                    </span>
                  </div>
                )}
                {ollamaStatus.error && (
                  <div className="text-stone-400 text-sm bg-red-500/10 border border-red-500/20 rounded p-2">
                    {ollamaStatus.error}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Provider Selection */}
      <div className="bg-stone-950 rounded-xl border border-stone-800 p-6 mb-6">
        <h2 className="text-xl text-white mb-4">Provider Configuration</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="text-stone-400 text-sm mb-2 block">
              Embedding Provider
            </label>
            <select
              value={currentProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={updating}
              className="w-full bg-stone-900 rounded-xl border border-stone-700 outline-none p-3 text-stone-200 disabled:opacity-50"
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.icon} {option.label}
                </option>
              ))}
            </select>
            {updating && (
              <div className="text-yellow-400 text-sm mt-2">
                Updating configuration...
              </div>
            )}
          </div>

          <div>
            <label className="text-stone-400 text-sm mb-2 block">
              Batch Processing Mode
            </label>
            <select
              value={config?.batchMode || 'simple'}
              onChange={(e) => handleBatchModeChange(e.target.value)}
              disabled={updating}
              className="w-full bg-stone-900 rounded-xl border border-stone-700 outline-none p-3 text-stone-200 disabled:opacity-50"
            >
              {BATCH_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="text-stone-400 text-xs mt-2">
              {
                BATCH_MODE_OPTIONS.find(
                  (m) => m.value === (config?.batchMode || 'simple'),
                )?.description
              }
            </div>
          </div>
        </div>
      </div>

      {/* Ollama Models Management */}
      {ollamaStatus?.available && (
        <div className="bg-stone-950 rounded-xl border border-stone-800 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl text-white">Ollama Models</h2>
            <button
              onClick={() => fetchOllamaModels()}
              className="rounded-xl p-2 px-4 bg-stone-900 hover:bg-stone-800 text-stone-200 text-sm"
            >
              Refresh
            </button>
          </div>

          <div className="space-y-2 max-h-80 overflow-y-auto">
            {ollamaModels.length === 0 ? (
              <div className="text-stone-400 text-center py-4">
                No models installed or Ollama unavailable
              </div>
            ) : (
              ollamaModels.map((model) => (
                <div
                  key={model.name}
                  className="flex items-center justify-between p-3 bg-stone-900/50 rounded-lg"
                >
                  <div className="flex flex-col">
                    <div className="text-stone-200 font-medium">
                      {model.name}
                    </div>
                    {model.size && (
                      <div className="text-stone-400 text-sm">
                        {(model.size / 1024 / 1024 / 1024).toFixed(2)} GB
                      </div>
                    )}
                  </div>
                  {model.name !== config?.model && (
                    <button
                      onClick={() => handlePullModel(model.name)}
                      disabled={pullingModel}
                      className="rounded-xl p-2 px-4 bg-blue-500 hover:bg-blue-600 text-white text-sm disabled:opacity-50"
                    >
                      {pullingModel ? 'Pulling...' : 'Pull Model'}
                    </button>
                  )}
                  {model.name === config?.model && (
                    <div className="text-green-400 text-sm font-medium">
                      Active
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-stone-800">
            <div className="text-stone-400 text-sm">
              Models shown here are available in your Ollama instance. Use the
              provider selector above to switch which model is used for
              embeddings.
            </div>
          </div>
        </div>
      )}

      {/* Test Interface */}
      <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
        <h2 className="text-xl text-white mb-4">Test Embedding Query</h2>

        <div className="space-y-4">
          <div>
            <label className="text-stone-400 text-sm block mb-2">
              Test Query
            </label>
            <textarea
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              placeholder="Enter a query to test embedding similarity..."
              className="w-full bg-stone-900 rounded-xl border border-stone-700 outline-none p-3 text-stone-200 min-h-20"
            />
          </div>

          <div className="flex space-x-3">
            <button
              onClick={handleTestEmbedding}
              disabled={!testInput.trim() || testLoading}
              className="rounded-xl p-3 px-6 bg-sky-500 hover:bg-sky-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testLoading ? 'Testing...' : 'Test Query'}
            </button>
          </div>

          {testResult && (
            <div className="bg-stone-900 rounded-xl p-4 border border-stone-700">
              <div className="text-stone-400 text-sm mb-1">Test Result:</div>
              <div className="text-stone-200 font-mono text-sm">
                {testResult}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
