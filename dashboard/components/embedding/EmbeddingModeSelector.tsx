'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertCircle, Clock, Zap } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import {
    getEmbeddingConfig,
    updateEmbeddingProvider,
    updateEmbeddingBatchMode,
    EmbeddingConfig,
    PROVIDER_OPTIONS,
    BATCH_MODE_OPTIONS,
    isRouterConfig
} from '@/lib/api';

interface EmbeddingModeSelectorProps {
    config?: EmbeddingConfig;
    onConfigChange?: (config: EmbeddingConfig) => void;
    className?: string;
}



export function EmbeddingModeSelector({ config, onConfigChange, className }: EmbeddingModeSelectorProps) {
    const [currentConfig, setCurrentConfig] = useState<EmbeddingConfig | null>(config || null);
    const [loading, setLoading] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadConfig = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const data = await getEmbeddingConfig();
            setCurrentConfig(data);
            onConfigChange?.(data);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            setError(errorMsg);
            toast.error('Failed to check configuration status', {
                description: errorMsg
            });
        } finally {
            setLoading(false);
        }
    }, [onConfigChange]);

    useEffect(() => {
        if (!config) {
            loadConfig();
        }
    }, [config, loadConfig]);

    // Polling effect when restart is in progress
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (restarting) {
            interval = setInterval(async () => {
                try {
                    await loadConfig();
                    setRestarting(false);
                    toast.success('Server restarted successfully', {
                        description: 'Configuration changes applied.'
                    });
                } catch (err) {
                    // Keep polling if server is still restarting
                    console.log('Server still restarting...');
                }
            }, 2000); // Poll every 2 seconds
        }
        return () => {
            if (interval) {
                clearInterval(interval);
            }
        };
    }, [restarting, loadConfig]);

    // loadConfig memoized above using useCallback - no duplicate implementation here

    const handleProviderChange = async (provider: string, routerSimd?: boolean, routerFallback?: boolean) => {
        if (!currentConfig?.provider) {
            toast.error('Configuration not loaded');
            return;
        }

        if (restarting) {
            toast.error('Server is restarting. Please wait.');
            return;
        }

        try {
            setUpdating(true);
            setError(null);

            // Validate inputs before making API call
            if (!provider) {
                throw new Error('Embedding provider is required');
            }

            const validProviders = ['synthetic', 'openai', 'gemini', 'ollama', 'router_cpu', 'local'];
            if (!validProviders.includes(provider)) {
                throw new Error(`Invalid embedding provider: ${provider}`);
            }

            // Validate router-specific parameters
            if (provider === 'router_cpu') {
                if (routerSimd !== undefined && typeof routerSimd !== 'boolean') {
                    throw new Error('SIMD enabled must be a boolean value');
                }
                if (routerFallback !== undefined && typeof routerFallback !== 'boolean') {
                    throw new Error('Fallback enabled must be a boolean value');
                }
            }

            const result = await updateEmbeddingProvider(provider, {
                router_simd_enabled: routerSimd,
                router_fallback_enabled: routerFallback,
            });

            // Check if restart is required based on response
            if (result.restart_required) {
                setRestarting(true);
                toast.warning('Provider updated. Server is restarting...', {
                    description: 'Please wait while changes are applied.',
                    duration: 10000,
                });
                // Don't refresh config immediately - polling effect will handle it
            } else {
                // For parameter-only changes, refresh config immediately
                await loadConfig();
                toast.success(`Provider updated to ${result.new_provider || provider}`);
            }

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred while updating provider';
            setError(errorMessage);
            toast.error(`Failed to update provider: ${errorMessage}`);
        } finally {
            setUpdating(false);
        }
    };

    const handleGlobalSimdChange = async (globalSimd: boolean) => {
        if (!currentConfig?.provider) {
            toast.error('Configuration not loaded');
            return;
        }

        try {
            setUpdating(true);
            setError(null);

            await updateEmbeddingProvider(currentConfig.provider, {
                global_simd_enabled: globalSimd,
                router_simd_enabled: currentConfig.simd_router_enabled,
                router_fallback_enabled: currentConfig.fallback_enabled,
            });

            // Since configuration is applied immediately, refresh config
            await loadConfig();

            toast.success(`Global SIMD ${globalSimd ? 'enabled' : 'disabled'}`);

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred while updating global SIMD';
            setError(errorMessage);
            toast.error(`Failed to update global SIMD: ${errorMessage}`);
        } finally {
            setUpdating(false);
        }
    };

    const handleRouterSimdChange = async (routerSimd: boolean) => {
        if (!currentConfig?.provider) {
            toast.error('Configuration not loaded');
            return;
        }

        try {
            setUpdating(true);
            setError(null);

            await updateEmbeddingProvider(currentConfig.provider, {
                global_simd_enabled: currentConfig.simd_global_enabled,
                router_simd_enabled: routerSimd,
                router_fallback_enabled: currentConfig.fallback_enabled,
            });

            // Since configuration is applied immediately, refresh config
            await loadConfig();

            // Warn if router SIMD enabled but global disabled
            if (routerSimd && !currentConfig.simd_global_enabled) {
                toast.warning('Router SIMD enabled but global disabled - fusion ops may be slower');
            }

            toast.success(`Router SIMD ${routerSimd ? 'enabled' : 'disabled'}`);

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred while updating router SIMD';
            setError(errorMessage);
            toast.error(`Failed to update router SIMD: ${errorMessage}`);
        } finally {
            setUpdating(false);
        }
    };

    const handleRouterFallbackChange = async (routerFallback: boolean) => {
        if (!currentConfig?.provider) {
            toast.error('Configuration not loaded');
            return;
        }

        try {
            setUpdating(true);
            setError(null);

            await updateEmbeddingProvider(currentConfig.provider, {
                global_simd_enabled: currentConfig.simd_global_enabled,
                router_simd_enabled: currentConfig.simd_router_enabled,
                router_fallback_enabled: routerFallback,
            });

            // Since configuration is applied immediately, refresh config
            await loadConfig();

            toast.success(`Router fallback ${routerFallback ? 'enabled' : 'disabled'}`);

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred while updating router fallback';
            setError(errorMessage);
            toast.error(`Failed to update router fallback: ${errorMessage}`);
        } finally {
            setUpdating(false);
        }
    };

    const handleEmbedModeChange = async (embedMode: 'simple' | 'advanced') => {
        if (!currentConfig?.provider) {
            toast.error('Configuration not loaded');
            return;
        }

        try {
            setUpdating(true);
            setError(null);

            // Validate embed_mode
            if (!['simple', 'advanced'].includes(embedMode)) {
                throw new Error(`Invalid embed mode: ${embedMode}`);
            }

            const result = await updateEmbeddingBatchMode(embedMode);

            // Batch mode changes do not require restart, so refresh config immediately
            await loadConfig();

            // Update toast message for batch mode changes to be clearer
            toast.success(`Batch mode updated to ${embedMode}`);

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred while updating batch mode';
            setError(errorMessage);
            toast.error(`Failed to update batch mode: ${errorMessage}`);
        } finally {
            setUpdating(false);
        }
    };

    // Note: No longer using legacy MODE_OPTIONS - using PROVIDER_OPTIONS from api

    return (
        <Card className={className}>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Zap className="w-5 h-5" />
                    Embedding Configuration
                </CardTitle>
                <CardDescription>
                    Configure how OpenMemory processes text into vector embeddings
                </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
                {restarting && (
                    <Alert>
                        <Clock className="h-4 w-4 animate-spin" />
                        <AlertDescription>
                            Server is restarting due to configuration changes. Please wait...
                        </AlertDescription>
                    </Alert>
                )}

                {error && (
                    <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                {/* Current Configuration Display */}
                {currentConfig && (
                    <div className="flex flex-col gap-2 mb-4">
                        <div className="flex items-center gap-2">
                            <Badge variant={updating ? 'secondary' : 'default'} className="flex items-center gap-1">
                                {updating && <Clock className="w-3 h-3 animate-spin" />}
                                {updating ? 'Updating...' : 'Provider: ' + (PROVIDER_OPTIONS.find(p => p.value === currentConfig.provider)?.label || currentConfig.provider)}
                            </Badge>
                            <Badge variant="outline" className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {'Batching: ' + (BATCH_MODE_OPTIONS.find(m => m.value === currentConfig.batchMode)?.label || currentConfig.batchMode)}
                            </Badge>
                        </div>
                        <div className="flex flex-wrap gap-1 items-center">
                            <span className="text-sm text-muted-foreground">
                                {currentConfig.dimensions} dimensions
                            </span>
                            <Badge variant={currentConfig.simd_global_enabled ? 'default' : 'secondary'} className="text-xs">
                                Global SIMD: {currentConfig.simd_global_enabled ? 'Enabled' : 'Disabled'}
                            </Badge>
                            {currentConfig.provider === 'router_cpu' && (
                                <Badge variant={currentConfig.simd_router_enabled ? 'default' : 'secondary'} className="text-xs">
                                    Router SIMD: {currentConfig.simd_router_enabled ? 'Enabled (+20-30% in routing)' : 'Disabled'}
                                </Badge>
                            )}
                        </div>
                    </div>
                )}

                {/* Embedding Batch Mode Selector */}
                {currentConfig && (
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Embedding Batch Mode</label>
                        <Select
                            value={currentConfig.batchMode || 'simple'}
                            onValueChange={(value) => handleEmbedModeChange(value as 'simple' | 'advanced')}
                            disabled={updating || loading || restarting}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Select embedding batch mode..." />
                            </SelectTrigger>
                            <SelectContent>
                                {BATCH_MODE_OPTIONS.map((mode) => (
                                    <SelectItem key={mode.value} value={mode.value}>
                                        <div className="flex items-center gap-2">
                                            <span>{mode.label}</span>
                                            <span className="text-xs text-muted-foreground">-</span>
                                            <span className="text-xs text-muted-foreground">{mode.description}</span>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {/* Global SIMD Settings - Always visible */}
                {currentConfig && (
                    <div className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="space-y-0.5">
                            <label className="text-sm font-medium">Global SIMD Optimization</label>
                            <p className="text-xs text-muted-foreground">
                                Enable SIMD for fusion and general vector ops across all providers (10-15% overall embedding speedup)
                            </p>
                        </div>
                        <Switch
                            checked={currentConfig.simd_global_enabled ?? false}
                            onCheckedChange={handleGlobalSimdChange}
                            disabled={updating || loading || restarting}
                        />
                    </div>
                )}

                {/* Embedding Provider Selector */}
                <div className="space-y-2">
                    <label className="text-sm font-medium">Embedding Provider</label>
                    <Select
                        value={currentConfig?.provider || ''}
                        onValueChange={(value) => handleProviderChange(value)}
                        disabled={updating || loading || restarting}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Select embedding provider..." />
                        </SelectTrigger>
                        <SelectContent>
                            {PROVIDER_OPTIONS.map((provider) => (
                                <SelectItem key={provider.value} value={provider.value}>
                                    <div className="flex items-center gap-2">
                                        <span>{provider.icon}</span>
                                        <span>{provider.label}</span>
                                        <span className="text-xs text-muted-foreground">-</span>
                                        <span className="text-xs text-muted-foreground">{provider.description}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Router CPU Settings */}
                {currentConfig?.provider === 'router_cpu' && (
                    <div className="space-y-3 p-4 border rounded-lg bg-muted/20">
                        <h4 className="text-sm font-medium">Router CPU Settings</h4>

                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium">Router SIMD Optimization</label>
                                <p className="text-xs text-muted-foreground">
                                    Enable SIMD for sector routing operations (+20-30% in routing/classification)
                                </p>
                            </div>
                            <Switch
                                checked={currentConfig.simd_router_enabled ?? false}
                                onCheckedChange={handleRouterSimdChange}
                                disabled={updating || loading || restarting}
                            />
                        </div>

                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium">Fallback to Synthetic</label>
                                <p className="text-xs text-muted-foreground">
                                    Use synthetic embeddings if Ollama models are unavailable
                                </p>
                            </div>
                            <Switch
                                checked={currentConfig.fallback_enabled ?? true}
                                onCheckedChange={(checked) => handleRouterFallbackChange(checked)}
                                disabled={updating || loading || restarting}
                            />
                        </div>

                        {currentConfig.performance && (
                            <div className="grid grid-cols-3 gap-4 pt-2 border-t">
                                <div className="text-center">
                                    <div className="text-xs text-muted-foreground">Expected P95</div>
                                    <div className="text-sm font-medium">{currentConfig.performance.expected_p95_ms}ms</div>
                                </div>
                                <div className="text-center">
                                    <div className="text-xs text-muted-foreground">SIMD Boost</div>
                                    <div className="text-sm font-medium">+{currentConfig.performance.expected_simd_improvement}%</div>
                                </div>
                                <div className="text-center">
                                    <div className="text-xs text-muted-foreground">RAM Usage</div>
                                    <div className="text-sm font-medium">{currentConfig.performance.memory_usage_gb}GB</div>
                                </div>
                            </div>
                        )}

                        {currentConfig.ollama_required && (
                            <Alert>
                                <AlertCircle className="h-4 w-4" />
                                <AlertDescription>
                                    Router mode requires Ollama service. Ensure Ollama is running and required models are installed.
                                </AlertDescription>
                            </Alert>
                        )}
                    </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-2 pt-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={loadConfig}
                        disabled={loading || updating || restarting}
                        className="flex-1"
                    >
                        {loading ? 'Checking...' : 'Refresh'}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
