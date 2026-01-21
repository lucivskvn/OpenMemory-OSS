"use client";

import { useState } from "react";
import { client } from "@/lib/api";
import {
    Download,
    Upload,
    FileJson,
    RefreshCcw,
    CheckCircle2,
    AlertCircle,
    Database,
    Binary
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function PortabilityView() {
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [importStatus, setImportStatus] = useState<string | null>(null);

    const handleExport = async () => {
        try {
            setExporting(true);
            toast.info("Preparing backup stream...");

            // For now we use the client's exportData which returns a string
            // In a real high-perf scenario we might want a direct anchor download if we can auth it
            const data = await client.admin.exportData();

            const blob = new Blob([data], { type: "application/x-ndjson" });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `openmemory-backup-${new Date().toISOString().split("T")[0]}.jsonl`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();

            toast.success("Identity & Knowledge Graph exported successfully");
        } catch (err) {
            console.error(err);
            toast.error("Export failed");
        } finally {
            setExporting(false);
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!confirm(`Importing "${file.name}" will merge with existing system data. Continue?`)) {
            e.target.value = "";
            return;
        }

        try {
            setImporting(true);
            setImportStatus("Reading file...");

            if (file.size > 50 * 1024 * 1024) {
                throw new Error("File too large (Max 50MB via browser)");
            }

            const text = await file.text();
            setImportStatus("Transmitting payload...");

            const res = await client.admin.importDatabase(text);

            toast.success(`Import successful: ${res.count} records processed`);
            setImportStatus(`Import Complete. ${res.count} items integrated.`);

            // Trigger a refresh of the dashboard after a short delay
            setTimeout(() => window.location.reload(), 2000);
        } catch (err: any) {
            console.error(err);
            toast.error(`Import failed: ${err.message}`);
            setImportStatus(`Error: ${err.message}`);
        } finally {
            e.target.value = "";
            setImporting(false);
        }
    };

    return (
        <div className="flex flex-col gap-8">
            <div className="flex items-center gap-4">
                <div className="p-2.5 bg-primary/10 rounded-xl text-primary">
                    <Binary size={24} />
                </div>
                <div>
                    <h2 className="text-xl font-black text-white uppercase tracking-tight">Portability & Sovereignty</h2>
                    <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Export your neural graph or restore from backup</p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Export Card */}
                <div className="glass-card border-white/5 p-8 flex flex-col gap-6 group hover:border-primary/20 transition-all">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-zinc-900 rounded-2xl text-zinc-400 group-hover:text-primary transition-colors">
                            <Download size={32} strokeWidth={1.5} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white">Full System Export</h3>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Generate NDJSON Backup</p>
                        </div>
                    </div>

                    <p className="text-sm text-zinc-400 leading-relaxed font-medium">
                        Creates a comprehensive, newline-delimited JSON archive of all users, API keys, source configurations, and memories.
                    </p>

                    <ul className="space-y-2 mt-2">
                        {["End-to-end encryption compatible", "Standard NDJSON format", "Includes knowledge graph"].map((item, i) => (
                            <li key={i} className="flex items-center gap-2 text-[10px] text-zinc-600 font-black uppercase tracking-widest">
                                <div className="w-1 h-1 rounded-full bg-primary" />
                                {item}
                            </li>
                        ))}
                    </ul>

                    <button
                        onClick={handleExport}
                        disabled={exporting}
                        className="mt-4 flex items-center justify-center gap-3 px-6 py-4 bg-white text-black rounded-2xl font-black uppercase tracking-[0.2em] text-xs hover:bg-zinc-200 transition-all active:scale-95 disabled:opacity-50"
                    >
                        {exporting ? <RefreshCcw className="animate-spin" size={16} /> : <Download size={16} />}
                        Initiate Export
                    </button>
                </div>

                {/* Import Card */}
                <div className="glass-card border-white/5 p-8 flex flex-col gap-6 group hover:border-emerald-500/20 transition-all">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-zinc-900 rounded-2xl text-zinc-400 group-hover:text-emerald-400 transition-colors">
                            <Upload size={32} strokeWidth={1.5} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white">Restore / Ingest</h3>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Import Knowledge Stream</p>
                        </div>
                    </div>

                    <p className="text-sm text-zinc-400 leading-relaxed font-medium">
                        Seamlessly merge external NDJSON data into your active memory core. Supports legacy OpenMemory formats.
                    </p>

                    <div className="mt-2 relative">
                        <input
                            type="file"
                            id="import-file"
                            accept=".jsonl,.ndjson,.json"
                            onChange={handleFileChange}
                            className="hidden"
                            disabled={importing}
                        />
                        <label
                            htmlFor="import-file"
                            className={cn(
                                "flex flex-col items-center justify-center p-8 border-2 border-dashed border-white/5 rounded-2xl cursor-pointer hover:bg-white/5 hover:border-emerald-500/30 transition-all group/label",
                                importing && "pointer-events-none opacity-50"
                            )}
                        >
                            {importing ? (
                                <RefreshCcw className="animate-spin text-emerald-400 mb-2" size={32} />
                            ) : (
                                <FileJson className="text-zinc-700 group-hover/label:text-emerald-500 transition-colors mb-2" size={32} />
                            )}
                            <span className="text-xs font-black uppercase tracking-widest text-zinc-500 group-hover/label:text-white transition-colors">
                                {importing ? "Processing Stream..." : "Drop payload here"}
                            </span>
                        </label>
                    </div>

                    {importStatus && (
                        <div className={cn(
                            "p-4 rounded-xl border flex items-center gap-3 animate-in fade-in zoom-in",
                            importStatus.includes("Error")
                                ? "bg-red-500/10 border-red-500/20 text-red-200"
                                : "bg-emerald-500/10 border-emerald-500/20 text-emerald-200"
                        )}>
                            {importStatus.includes("Error") ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
                            <span className="text-[10px] font-bold uppercase tracking-widest">{importStatus}</span>
                        </div>
                    )}
                </div>
            </div>

            <div className="p-6 glass-card border-amber-500/20 bg-amber-500/5 flex items-start gap-4">
                <div className="p-2 bg-amber-500/20 rounded-lg text-amber-500">
                    <AlertCircle size={20} />
                </div>
                <div>
                    <h4 className="text-sm font-black text-white uppercase tracking-tight mb-1">Critical Notice</h4>
                    <p className="text-xs text-zinc-400 font-medium leading-relaxed">
                        Importing data will not delete existing records but may update existing metadata if IDs conflict.
                        Always perform a full export before major system migrations.
                    </p>
                </div>
            </div>
        </div>
    );
}
