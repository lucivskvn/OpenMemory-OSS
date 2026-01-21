"use client";

import { useState, useEffect } from "react";
import { client } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Trash2, Plus, GitBranch, Database, FileText, CheckCircle, XCircle, Globe } from "lucide-react";
import { toast } from "sonner";
import type { SourceRegistryEntry } from "@/lib/types";

const AVAILABLE_SOURCES = [
    { id: "github", label: "GitHub", icon: GitBranch },
    { id: "notion", label: "Notion", icon: FileText },
    { id: "google_drive", label: "Google Drive", icon: Database },
    { id: "google_sheets", label: "Google Sheets", icon: FileText },
    { id: "google_slides", label: "Google Slides", icon: FileText },
    { id: "onedrive", label: "OneDrive", icon: Database },
    { id: "web_crawler", label: "Web Crawler", icon: Globe },
];

export const ConnectorSettings = () => {
    const [configs, setConfigs] = useState<SourceRegistryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAdd, setShowAdd] = useState(false);
    const [newType, setNewType] = useState("github");
    const [newConfig, setNewConfig] = useState("{}");
    const [error, setError] = useState<string | null>(null);

    const loadConfigs = async () => {
        try {
            setLoading(true);
            const data = await client.getSourceConfigs();
            setConfigs(data);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadConfigs();
    }, []);

    const handleDelete = async (type: string) => {
        // We use a custom toast instead of native confirm for better UI, or just stick to confirm for now
        if (!confirm(`Are you sure you want to remove ${type}?`)) return;
        try {
            await client.deleteSourceConfig(type);
            toast.success(`Deleted ${type} configuration`);
            loadConfigs();
        } catch (err: unknown) {
            console.error("Delete failed:", err);
            toast.error("Failed to delete configuration");
        }
    };

    const handleSave = async () => {
        try {
            setError(null);
            const parsed = JSON.parse(newConfig);
            await client.setSourceConfig(newType, parsed, "enabled");
            toast.success(`Configured ${newType} successfully`);
            setShowAdd(false);
            setNewConfig("{}");
            loadConfigs();
        } catch (err: unknown) {
            console.error(err);
            toast.error("Invalid JSON or server error");
            setError("Invalid JSON or server error");
        }
    };

    return (
        <div className="space-y-6">
            {/* Active Connectors Section */}
            <div className="space-y-4">
                <div className="flex items-center justify-between px-2">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-500/10 rounded-lg text-blue-400">
                            <Globe size={20} />
                        </div>
                        <h3 className="text-sm font-black uppercase tracking-widest text-white">External Connectors</h3>
                    </div>
                    <button
                        onClick={() => setShowAdd(!showAdd)}
                        className="flex items-center gap-2 px-4 py-2 bg-primary/20 text-primary border border-primary/20 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-primary/30 transition-all active:scale-95 shadow-lg shadow-primary/5"
                    >
                        {showAdd ? <XCircle size={14} /> : <Plus size={14} />}
                        {showAdd ? "Close Panel" : "Add Source"}
                    </button>
                </div>

                {/* Add Form */}
                {showAdd && (
                    <div className="p-8 rounded-3xl bg-white/5 border border-white/10 space-y-6 animate-in fade-in slide-in-from-top-4 duration-500 glass-card">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="flex flex-col gap-3">
                                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500 ml-1">Protocol Selection</label>
                                <select
                                    value={newType}
                                    onChange={(e) => setNewType(e.target.value)}
                                    className="bg-black/40 border border-white/10 rounded-2xl p-4 text-sm text-white focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
                                >
                                    {AVAILABLE_SOURCES.map(s => (
                                        <option key={s.id} value={s.id} className="bg-zinc-900">{s.label}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="flex flex-col gap-3">
                            <label className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500 ml-1">Payload Specification (JSON)</label>
                            <textarea
                                value={newConfig}
                                onChange={(e) => setNewConfig(e.target.value)}
                                className="bg-black/40 border border-white/10 rounded-2xl p-5 text-sm font-mono h-48 focus:outline-none focus:border-primary/50 transition-colors text-white placeholder:text-zinc-700 resize-none shadow-inner"
                                placeholder='{ "apiKey": "sk-...", "orgId": "..." }'
                            />
                        </div>

                        {error && <p className="text-red-400 text-[10px] font-black uppercase tracking-widest px-2 flex items-center gap-2 animate-pulse">
                            <XCircle size={12} /> {error}
                        </p>}

                        <div className="flex justify-end gap-4 pt-2">
                            <button
                                onClick={() => setShowAdd(false)}
                                className="px-6 py-2 text-[10px] font-black uppercase tracking-widest text-zinc-400 hover:text-white transition-colors"
                            >
                                Discard
                            </button>
                            <button
                                onClick={handleSave}
                                className="px-8 py-3 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-500/20 hover:border-emerald-500/40 transition-all active:scale-95 shadow-lg shadow-emerald-500/10"
                            >
                                Register Connector
                            </button>
                        </div>
                    </div>
                )}

                {/* List */}
                {loading ? (
                    <div className="flex items-center justify-center p-20 text-zinc-600 text-[10px] font-black uppercase tracking-[0.3em] gap-4">
                        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        Synchronizing Registry
                    </div>
                ) : configs.length === 0 ? (
                    <div className="p-20 rounded-3xl border-2 border-dashed border-white/5 text-center text-zinc-600 text-[10px] font-black uppercase tracking-[0.2em] italic bg-white/[0.01]">
                        No active connectors identified.
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {configs.map((cfg) => {
                            const sourceDef = AVAILABLE_SOURCES.find(s => s.id === cfg.type);
                            const Icon = sourceDef?.icon || Database;
                            return (
                                <div key={cfg.type} className="p-6 rounded-3xl bg-white/[0.03] border border-white/5 flex items-start justify-between group hover:bg-white/[0.08] transition-all hover:border-primary/20 hover:shadow-2xl hover:shadow-primary/5">
                                    <div className="flex items-start gap-5">
                                        <div className="p-4 rounded-2xl bg-primary/10 text-primary shadow-inner border border-white/5">
                                            <Icon size={24} />
                                        </div>
                                        <div className="space-y-1">
                                            <h4 className="text-sm font-black text-white tracking-widest uppercase">{sourceDef?.label || cfg.type}</h4>
                                            <div className="flex items-center gap-2 mt-1">
                                                <div className={cn(
                                                    "w-1.5 h-1.5 rounded-full shadow-[0_0_8px]",
                                                    cfg.status === "enabled" ? "bg-emerald-500 shadow-emerald-500/50" : "bg-red-500 shadow-red-500/50"
                                                )} />
                                                <span className={cn(
                                                    "text-[9px] font-black uppercase tracking-[0.2em]",
                                                    cfg.status === "enabled" ? "text-emerald-400/80" : "text-red-400/80"
                                                )}>{cfg.status}</span>
                                            </div>
                                            <p className="text-[9px] text-zinc-600 mt-4 font-bold uppercase tracking-widest">
                                                Init: {new Date(cfg.updatedAt).toLocaleDateString()}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleDelete(cfg.type)}
                                        className="p-3 text-zinc-700 hover:text-red-400 hover:bg-red-400/10 rounded-xl opacity-0 group-hover:opacity-100 transition-all border border-transparent hover:border-red-400/20"
                                        title="Delete Configuration"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};
