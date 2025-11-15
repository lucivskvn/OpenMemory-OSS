'use client';

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle, Clock, Zap, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { getEmbeddingConfig, updateEmbeddingProvider, EmbeddingConfig } from '@/lib/api';

interface EmbeddingModeSelectorProps {
    config?: EmbeddingConfig;
    onConfigChange?: (config: EmbeddingConfig) => void;
    className?: string;
}

const MODE_OPTIONS = [
    { value: 'synthetic', label: 'Synthetic', description: 'Fast local generation', icon: <Zap className="w-4 h-4" />, color: 'bg-purple-500' },
    { value: 'openai', label: 'OpenAI', description: 'Cloud embeddings', icon: <CheckCircle className="w-4 h-4" />, color: 'bg-blue-500' },
    { value: 'gemini', label: 'Gemini', description: 'Google embeddings', icon: <CheckCircle className="w-4 h-4" />, color: 'bg-green-500' },
    { value: 'ollama', label: 'Ollama', description: 'Local AI models', icon: <CheckCircle className="w-4 h-4" />, color: 'bg-orange-500' },
    { value: 'router_cpu', label: 'Router CPU', description: 'Optimized CPU routing', icon: <Zap className="w-4 h-4" />, color: 'bg-red-500' },
    { value: 'local', label: 'Local', description: 'Custom local model', icon: <AlertCircle className="w-4 h-4" />, color: 'bg-gray-500' },
];

export function EmbeddingModeSelector({ config, onConfigChange, className }: EmbeddingModeSelectorProps) {
    const [currentConfig, setCurrentConfig] = useState<EmbeddingConfig | null>(config || null);
    const [loading, setLoading] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!config) {
            loadConfig();
        }
    }, [config]);

    const loadConfig = async () => {
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
    };

    const handleModeChange = async (newMode: string, routerSimd?: boolean, routerFallback?: boolean, embedMode?: string) => {
        try {
            setUpdating(true);
            setError(null);

            // Validate inputs before making API call
            if (!newMode) {
                throw new Error('Embedding mode is required');
            }

            const validModes = ['synthetic', 'openai', 'gemini', 'ollama', 'router_cpu', 'local'];
            if (!validModes.includes(newMode)) {
                throw new Error(`Invalid embedding mode: ${newMode}`);
            }

            // Validate router-specific parameters
            if (newMode === 'router_cpu') {
                if (routerSimd !== undefined && typeof routerSimd !== 'boolean') {
                    throw new Error('SIMD enabled must be a boolean value');
                }
                if (routerFallback !== undefined && typeof routerFallback !== 'boolean') {
                    throw new Error('Fallback enabled must be a boolean value');
                }
            }

            // Validate embed_mode if provided
            if (embedMode && !['simple', 'advanced'].includes(embedMode)) {
                throw new Error(`Invalid embed mode: ${embedMode}`);
            }

            await updateEmbeddingProvider(newMode, {
                router_simd_enabled: routerSimd,
                router_fallback_enabled: routerFallback,
                embed_mode: embedMode,
            });

            // Since configuration is applied immediately, refresh config
            await loadConfig();

            toast.success(`Configuration updated`);

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred while updating configuration';
            setError(errorMessage);
            toast.error(`Failed to update configuration: ${errorMessage}`);
        } finally {
            setUpdating(false);
        }
    };

    const selectedMode = MODE_OPTIONS.find(m => m.value === currentConfig?.kind);

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
                {error && (
                    <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                {/* Current Configuration Display */}
                {currentConfig && (
                    <div className="flex items-center gap-2 mb-4">
                        <Badge variant={updating ? 'secondary' : 'default'} className="flex items-center gap-1">
                            {updating && <Clock className="w-3 h-3 animate-spin" />}
                            {!updating && selectedMode?.icon}
                            {updating ? 'Updating...' : selectedMode?.label || currentConfig.kind}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                            {currentConfig.dimensions} dimensions • {currentConfig.mode} mode
                        </span>
                    </div>
                )}

                {/* Mode Selector */}
                {currentConfig && (
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Embedding Mode</label>
                        <Select
                            value={currentConfig.mode || 'advanced'}
                            onValueChange={(value) => handleModeChange(currentConfig.kind, undefined, undefined, value)}
                            disabled={updating}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Select embedding mode..." />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="simple">
                                    <div className="flex items-center gap-2">
                                        <Clock className="w-4 h-4" />
                                        <span>Simple</span>
                                        <span className="text-xs text-muted-foreground">-</span>
                                        <span className="text-xs text-muted-foreground">Batch processing</span>
                                    </div>
                                </SelectItem>
                                <SelectItem value="advanced">
                                    <div className="flex items-center gap-2">
                                        <Zap className="w-4 h-4" />
                                        <span>Advanced</span>
                                        <span className="text-xs text-muted-foreground">-</span>
                                        <span className="text-xs text-muted-foreground">Per-sector parallel</span>
                                    </div>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {/* Mode Selector */}
                <div className="space-y-2">
                    <label className="text-sm font-medium">Embedding Provider</label>
                    <Select
                        value={currentConfig?.kind || ''}
                        onValueChange={(value) => handleModeChange(value)}
                        disabled={updating}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Select embedding provider..." />
                        </SelectTrigger>
                        <SelectContent>
                            {MODE_OPTIONS.map((mode) => (
                                <SelectItem key={mode.value} value={mode.value}>
                                    <div className="flex items-center gap-2">
                                        {mode.icon}
                                        <span>{mode.label}</span>
                                        <span className="text-xs text-muted-foreground">-</span>
                                        <span className="text-xs text-muted-foreground">{mode.description}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Router CPU Settings */}
                {currentConfig?.kind === 'router_cpu' && (
                    <div className="space-y-3 p-4 border rounded-lg bg-muted/20">
                        <h4 className="text-sm font-medium">Router CPU Settings</h4>

                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium">SIMD Optimization</label>
                                <p className="text-xs text-muted-foreground">
                                    Enable 20-30% performance boost (may be disabled by OM_SIMD_ENABLED=false)
                                </p>
                            </div>
                            <Switch
                                checked={currentConfig.simd_enabled ?? false}
                                onCheckedChange={(checked) => handleModeChange('router_cpu', checked, currentConfig.fallback_enabled)}
                                disabled={updating}
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
                                onCheckedChange={(checked) => handleModeChange('router_cpu', currentConfig.simd_enabled, checked)}
                                disabled={updating}
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
                        disabled={loading || updating}
                        className="flex-1"
                    >
                        {loading ? 'Checking...' : 'Refresh'}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
