"use client";

import { useState, useEffect } from "react";
import { client } from "@/lib/api";
import {
    ShieldCheck,
    Search,
    Filter,
    Trash2,
    Activity,
    Info,
    Calendar,
    Clock,
    User,
    Tag,
    RefreshCcw,
    AlertCircle,
    CheckCircle
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { AuditLogEntry, AuditStats } from "@/lib/types";

export function AuditLogViewer() {
    const [logs, setLogs] = useState<AuditLogEntry[]>([]);
    const [stats, setStats] = useState<AuditStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [filterUserId, setFilterUserId] = useState("");
    const [filterAction, setFilterAction] = useState("");

    const loadData = async () => {
        try {
            setLoading(true);
            const [logsData, statsData] = await Promise.all([
                client.admin.getAuditLogs({
                    userId: filterUserId || undefined,
                    action: filterAction || undefined,
                    limit: 100
                }),
                client.admin.getAuditStats()
            ]);
            setLogs(logsData);
            setStats(statsData);
        } catch (err) {
            console.error(err);
            toast.error("Failed to load audit logs");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, [filterAction]); // Refresh on action change, userId might need a debounce if we used a search box

    const handlePurge = async () => {
        const days = prompt("Purge logs older than how many days? (e.g. 30)");
        if (!days) return;
        const before = new Date();
        before.setDate(before.getDate() - parseInt(days));

        if (!confirm(`Permanently delete all audit logs before ${before.toLocaleDateString()}?`)) return;

        try {
            const res = await client.admin.purgeAuditLogs(before);
            toast.success(`Purged ${res.deleted} log entries`);
            loadData();
        } catch (err) {
            toast.error("Purge failed");
        }
    };

    return (
        <div className="flex flex-col gap-8">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <div className="p-2.5 bg-primary/10 rounded-xl text-primary">
                        <ShieldCheck size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-black text-white uppercase tracking-tight">Security & System Audit</h2>
                        <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Tamper-evident activity monitoring</p>
                    </div>
                </div>
                <button
                    onClick={handlePurge}
                    className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl text-sm font-bold hover:bg-red-500/20 transition-all active:scale-95"
                >
                    <Trash2 size={16} />
                    Purge Logs
                </button>
            </div>

            {/* Stats Bar */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="glass-card border-white/5 p-6 flex flex-col gap-1">
                    <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest leading-none">Total Events</p>
                    <p className="text-3xl font-black text-white">{stats?.totalEvents || 0}</p>
                </div>
                <div className="glass-card border-white/5 p-6 flex flex-col gap-1">
                    <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest leading-none">Security Incidents</p>
                    <p className="text-3xl font-black text-amber-500">{stats?.criticalEvents || 0}</p>
                </div>
                <div className="glass-card border-white/5 p-6 flex flex-col gap-1">
                    <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest leading-none">Retention Window</p>
                    <p className="text-xl font-black text-zinc-400 mt-2 uppercase">30 Days Active</p>
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-4 p-4 glass-card border-white/5 bg-zinc-900/40">
                <div className="flex items-center gap-3 bg-black/40 border border-white/10 rounded-xl px-4 py-2 flex-1 min-w-[200px]">
                    <Search size={14} className="text-zinc-500" />
                    <input
                        type="text"
                        placeholder="Search Identity..."
                        value={filterUserId}
                        onChange={(e) => setFilterUserId(e.target.value)}
                        className="bg-transparent border-none focus:outline-none text-xs text-white w-full placeholder:text-zinc-700"
                    />
                    {filterUserId && (
                        <button onClick={() => { setFilterUserId(""); loadData(); }} className="text-zinc-600 hover:text-white">
                            <Activity size={12} />
                        </button>
                    )}
                </div>

                <div className="flex items-center gap-3 bg-black/40 border border-white/10 rounded-xl px-4 py-2 flex-1 min-w-[200px]">
                    <Filter size={14} className="text-zinc-500" />
                    <select
                        value={filterAction}
                        onChange={(e) => setFilterAction(e.target.value)}
                        className="bg-transparent border-none focus:outline-none text-xs text-white w-full appearance-none cursor-pointer"
                    >
                        <option value="" className="bg-zinc-900">All Operations</option>
                        <option value="create_memory" className="bg-zinc-900">Create Memory</option>
                        <option value="delete_memory" className="bg-zinc-900">Delete Memory</option>
                        <option value="admin_provision" className="bg-zinc-900">Admin Provision</option>
                        <option value="key_gen" className="bg-zinc-900">Key Generation</option>
                        <option value="system_config" className="bg-zinc-900">System Config</option>
                    </select>
                </div>

                <button
                    onClick={loadData}
                    className="p-3 bg-white/5 hover:bg-white/10 rounded-xl transition-all"
                >
                    <RefreshCcw size={16} className={cn(loading && "animate-spin")} />
                </button>
            </div>

            {/* Log Table */}
            <div className="glass-card border-white/5 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-white/5 bg-white/[0.02]">
                                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Timestamp</th>
                                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Actor</th>
                                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Operation</th>
                                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Target</th>
                                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.02]">
                            {loading ? (
                                [...Array(10)].map((_, i) => (
                                    <tr key={i} className="animate-pulse">
                                        {[...Array(5)].map((_, j) => (
                                            <td key={j} className="px-6 py-4"><div className="h-4 bg-zinc-800 rounded w-full" /></td>
                                        ))}
                                    </tr>
                                ))
                            ) : logs.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-6 py-20 text-center text-zinc-500 italic text-sm">No log entries found matching criteria.</td>
                                </tr>
                            ) : (
                                logs.map((log) => (
                                    <tr key={log.id} className="hover:bg-white/[0.01] transition-colors group">
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="flex flex-col">
                                                <span className="text-xs font-bold text-zinc-300">{new Date(log.timestamp).toLocaleDateString()}</span>
                                                <span className="text-[9px] font-medium text-zinc-600">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <div className="w-6 h-6 rounded-md bg-zinc-900 flex items-center justify-center text-[10px] font-bold text-zinc-500">
                                                    <User size={12} />
                                                </div>
                                                <span className="text-xs font-bold text-white tracking-tight">{log.userId}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <Tag size={12} className="text-primary" />
                                                <span className="text-xs font-black uppercase tracking-tighter text-zinc-300">{log.action.replace(/_/g, " ")}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2 max-w-[200px] overflow-hidden">
                                                <span className="text-[10px] font-mono text-zinc-500 truncate">{log.resourceId}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className={cn(
                                                "px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-1.5",
                                                (log.metadata?.statusCode as number || 200) < 300 ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"
                                            )}>
                                                {(log.metadata?.statusCode as number || 200) < 300 ? <CheckCircle size={10} /> : <AlertCircle size={10} />}
                                                {log.metadata?.statusCode as number || 200}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="flex items-center gap-3 p-4 bg-zinc-900 border border-white/5 rounded-2xl text-[10px] text-zinc-600 font-bold italic">
                <Info size={14} className="text-primary" />
                Audit records are signed and immutable within the SQLite store for forensic integrity.
            </div>
        </div>
    );
}
