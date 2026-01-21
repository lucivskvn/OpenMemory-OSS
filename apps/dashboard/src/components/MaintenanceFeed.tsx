"use client";
import React from "react";
import { cn } from "@/lib/utils";
import type { MaintLogEntry, MaintenanceStatus } from "@/lib/types";

interface MaintenanceFeedProps {
    logs: MaintLogEntry[];
    status?: MaintenanceStatus | null;
}

export const MaintenanceFeed: React.FC<MaintenanceFeedProps> = ({ logs, status }) => {
    if (!logs.length && (!status || status.activeJobs.length === 0)) {
        return (
            <div className="glass-card p-8 text-center text-zinc-500 italic text-sm">
                No maintenance logs found.
            </div>
        );
    }

    return (
        <div className="glass-card flex flex-col gap-4 max-h-[400px]">
            <h2 className="text-xl font-bold px-1 border-b border-white/5 pb-2 flex justify-between items-center">
                <span>System Ops</span>
                <div className="flex items-center gap-2">
                    {status && status.activeJobs.length > 0 && (
                        <span className="text-[10px] bg-yellow-500/10 text-yellow-500 px-2 py-1 rounded-full font-black uppercase tracking-widest animate-pulse border border-yellow-500/20">
                            {status.activeJobs.length} Active
                        </span>
                    )}
                    <span className="text-[10px] bg-white/5 px-2 py-1 rounded-full text-zinc-500 font-bold uppercase tracking-widest">Last 24h</span>
                </div>
            </h2>
            {status && status.activeJobs.length > 0 && (
                <div className="bg-yellow-500/5 p-3 rounded-xl border border-yellow-500/10 flex flex-col gap-2">
                    <span className="text-[9px] font-black text-yellow-500/60 uppercase tracking-widest">Running Now</span>
                    {status.activeJobs.map((job: string, i: number) => (
                        <div key={i} className="flex justify-between items-center text-xs">
                            <span className="font-bold text-yellow-200">{job}</span>
                        </div>
                    ))}
                </div>
            )}
            <div className="flex-1 overflow-y-auto pr-2 flex flex-col gap-2 custom-scrollbar">
                {logs.map((log) => (
                    <div
                        key={`${log.id}-${log.ts}`}
                        className="bg-white/5 hover:bg-white/10 p-3 rounded-xl transition-all border-l-4 border-transparent hover:border-purple-500/50 group cursor-default"
                    >
                        <div className="flex justify-between items-center mb-1.5">
                            <span className="text-[10px] font-black text-purple-400 uppercase tracking-widest">
                                {log.op}
                            </span>
                            <span className={cn(
                                "text-[10px] px-2 py-0.5 rounded-md font-black uppercase tracking-widest border",
                                log.status === 'success'
                                    ? 'bg-green-500/10 text-green-400 border-green-500/20'
                                    : 'bg-red-500/10 text-red-400 border-red-500/20'
                            )}>
                                {log.status}
                            </span>
                        </div>
                        <div className="text-[10px] font-bold text-zinc-600 mb-2 truncate">
                            {new Date(log.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                        </div>
                        {log.details && (
                            <div className="text-[11px] text-zinc-400 font-mono bg-black/40 p-2 rounded-lg border border-white/5 truncate group-hover:bg-black/60 transition-colors">
                                {log.details}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};
