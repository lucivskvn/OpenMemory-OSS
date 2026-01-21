"use client";

import { useState, useEffect } from "react";
import { client } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Save, Cpu, ShieldCheck, Zap, RefreshCw, Key, Info } from "lucide-react";
import { toast } from "sonner";

interface ProviderConfig {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    organizationId?: string;
}

const PROVIDERS = [
    {
        id: "openai",
        label: "OpenAI",
        icon: Zap,
        color: "text-emerald-400",
        bg: "bg-emerald-500/10",
        fields: ["apiKey", "model", "organizationId"]
    },
    {
        id: "anthropic",
        label: "Anthropic",
        icon: Cpu,
        color: "text-orange-400",
        bg: "bg-orange-500/10",
        fields: ["apiKey", "model"]
    },
    {
        id: "gemini",
        label: "Google Gemini",
        icon: Zap,
        color: "text-blue-400",
        bg: "bg-blue-500/10",
        fields: ["apiKey", "model"]
    },
    {
        id: "ollama",
        label: "Ollama (Local)",
        icon: RefreshCw,
        color: "text-purple-400",
        bg: "bg-purple-500/10",
        fields: ["baseUrl", "model"]
    }
];

export const SystemConfig = () => {
    const [configs, setConfigs] = useState<Record<string, ProviderConfig>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);

    const loadSettings = async () => {
        try {
            setLoading(true);
            const data = await client.getSettings();
            setConfigs(data);
        } catch (err) {
            console.error("Failed to load settings:", err);
            toast.error("Cloud synchronization failed");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSettings();
    }, []);

    const handleChange = (provider: string, field: string, value: string) => {
        setConfigs(prev => ({
            ...prev,
            [provider]: {
                ...(prev[provider] || {}),
                [field]: value
            }
        }));
    };

    const handleSave = async (provider: string) => {
        try {
            setSaving(provider);
            const config = configs[provider] || {};
            await (client as any).updateSettings(provider as any, config);
            toast.success(`${provider.toUpperCase()} parameters updated`);
        } catch (err) {
            console.error("Save failed:", err);
            toast.error("Failed to commit changes");
        } finally {
            setSaving(null);
        }
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center p-20 gap-4 text-zinc-600">
                <RefreshCw size={24} className="animate-spin" />
                <p className="text-[10px] font-black uppercase tracking-[0.3em]">Calibrating Neural Pathways</p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
            {PROVIDERS.map((provider) => (
                <div
                    key={provider.id}
                    className="p-8 rounded-[2.5rem] bg-white/[0.02] border border-white/5 space-y-8 glass-card hover:bg-white/[0.04] transition-all duration-500 group"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-5">
                            <div className={cn("p-4 rounded-2xl shadow-inner border border-white/5 group-hover:scale-110 transition-transform duration-500", provider.bg, provider.color)}>
                                <provider.icon size={28} strokeWidth={1.5} />
                            </div>
                            <div>
                                <h3 className="text-lg font-black text-white tracking-widest uppercase italic">{provider.label}</h3>
                                <div className="flex items-center gap-2 mt-1">
                                    <ShieldCheck size={12} className="text-zinc-500" />
                                    <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">End-to-End Encrypted</span>
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={() => handleSave(provider.id)}
                            disabled={saving === provider.id}
                            className={cn(
                                "p-4 rounded-2xl border transition-all active:scale-95 shadow-lg",
                                saving === provider.id
                                    ? "bg-zinc-800 border-zinc-700 text-zinc-500 cursor-not-allowed"
                                    : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 hover:shadow-emerald-500/10"
                            )}
                        >
                            {saving === provider.id ? <RefreshCw size={20} className="animate-spin" /> : <Save size={20} />}
                        </button>
                    </div>

                    {/* Form Fields */}
                    <div className="space-y-6">
                        {provider.fields.map((field) => (
                            <div key={field} className="flex flex-col gap-2.5">
                                <label className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500 px-1 ml-1 flex items-center gap-2">
                                    {field === 'apiKey' ? <Key size={10} /> : <Info size={10} />}
                                    {field === 'apiKey' ? 'Authorization Key' : field === 'baseUrl' ? 'Connection Endpoint' : field}
                                </label>
                                <input
                                    type={field === 'apiKey' ? 'password' : 'text'}
                                    value={configs[provider.id]?.[field as keyof ProviderConfig] || ""}
                                    onChange={(e) => handleChange(provider.id, field, e.target.value)}
                                    placeholder={
                                        field === 'apiKey' ? "••••••••••••••••" :
                                            field === 'model' ? "e.g. gpt-4o, claude-3-sonnet" :
                                                field === 'baseUrl' ? "http://localhost:11434" :
                                                    ""
                                    }
                                    className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-4 text-sm text-white focus:outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all placeholder:text-zinc-800"
                                />
                            </div>
                        ))}
                    </div>

                    <div className="pt-4 border-t border-white/5">
                        <p className="text-[9px] text-zinc-600 font-bold uppercase tracking-widest flex items-center gap-2">
                            <Info size={12} />
                            These settings override server-side environment variables for your cognitive sessions.
                        </p>
                    </div>
                </div>
            ))}
        </div>
    );
};
