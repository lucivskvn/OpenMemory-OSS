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
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-medium text-white">Active Connectors</h3>
                <button
                    onClick={() => setShowAdd(!showAdd)}
                    className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-all active:scale-95 shadow-lg shadow-primary/20"
                >
                    <Plus size={16} />
                    Add Connector
                </button>
            </div>

            {/* Add Form */}
            {showAdd && (
                <div className="p-6 rounded-2xl bg-white/5 border border-white/10 space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="flex flex-col gap-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Source Type</label>
                        <select
                            value={newType}
                            onChange={(e) => setNewType(e.target.value)}
                            className="bg-black/40 border border-white/10 rounded-xl p-3 text-sm text-white focus:outline-none focus:border-primary/50 transition-colors appearance-none"
                        >
                            {AVAILABLE_SOURCES.map(s => (
                                <option key={s.id} value={s.id} className="bg-zinc-900">{s.label}</option>
                            ))}
                        </select>
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Configuration (JSON)</label>
                        <textarea
                            value={newConfig}
                            onChange={(e) => setNewConfig(e.target.value)}
                            className="bg-black/40 border border-white/10 rounded-xl p-4 text-sm font-mono h-48 focus:outline-none focus:border-primary/50 transition-colors text-white placeholder:text-zinc-600"
                            placeholder='{ "token": "..." }'
                        />
                    </div>

                    {error && <p className="text-red-400 text-xs font-medium px-1 italic">⚠ {error}</p>}

                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            onClick={() => setShowAdd(false)}
                            className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-white transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            className="px-6 py-2 bg-green-600/20 text-green-400 border border-green-500/20 rounded-xl text-sm font-bold hover:bg-green-600/30 hover:border-green-500/40 transition-all active:scale-95"
                        >
                            Save Connector
                        </button>
                    </div>
                </div>
            )}

            {/* List */}
            {loading ? (
                <div className="flex items-center justify-center p-12 text-muted-foreground text-sm gap-3">
                    <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    Checking registry...
                </div>
            ) : configs.length === 0 ? (
                <div className="p-12 rounded-2xl border border-dashed border-white/10 text-center text-muted-foreground text-sm italic">
                    No active connectors found. Configure a source to begin ingestion.
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {configs.map((cfg) => {
                        const sourceDef = AVAILABLE_SOURCES.find(s => s.id === cfg.type);
                        const Icon = sourceDef?.icon || Database;
                        return (
                            <div key={cfg.type} className="p-5 rounded-2xl bg-white/5 border border-white/10 flex items-start justify-between group hover:bg-white/10 transition-all hover:border-white/20">
                                <div className="flex items-start gap-4">
                                    <div className="p-3 rounded-xl bg-primary/10 text-primary shadow-inner">
                                        <Icon size={24} />
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-white tracking-tight">{sourceDef?.label || cfg.type}</h4>
                                        <div className="flex items-center gap-1.5 mt-1.5">
                                            {cfg.status === "enabled" ? (
                                                <CheckCircle size={14} className="text-green-500" />
                                            ) : (
                                                <XCircle size={14} className="text-red-500" />
                                            )}
                                            <span className={cn(
                                                "text-[10px] font-bold uppercase tracking-widest",
                                                cfg.status === "enabled" ? "text-green-400" : "text-red-400"
                                            )}>{cfg.status}</span>
                                        </div>
                                        <p className="text-[10px] text-zinc-500 mt-3 font-medium uppercase tracking-tighter">
                                            Active since: {new Date(cfg.updatedAt).toLocaleDateString()}
                                        </p>
                                    </div>
                                </div>
                                <button
                                    onClick={() => handleDelete(cfg.type)}
                                    className="p-2 text-zinc-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                                    title="Delete Configuration"
                                >
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
