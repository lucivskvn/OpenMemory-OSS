"use client";

import { useEffect, useMemo, useState } from "react";
// TimelineItem not used, we use local definition matching api.ts
import { cn } from "../lib/utils";
import { Clock, Calendar } from "lucide-react";

// Custom type for our client-side aggregation
interface AggregatedBucket {
    bucketKey: string;
    timestampMs: number;
    counts: Record<string, number>;
}

interface TimelineProps {
    data: AggregatedBucket[];
    isLoading?: boolean;
}

export const Timeline = ({ data, isLoading }: TimelineProps) => {
    // Determine max count for scaling
    const maxCount = useMemo(() => {
        if (!data || data.length === 0) return 0;
        return Math.max(...data.map(item =>
            Object.values(item.counts).reduce((a, b) => a + b, 0)
        ));
    }, [data]);

    if (isLoading) {
        return (
            <div className="h-48 glass-card animate-pulse flex items-center justify-center text-zinc-600 font-mono text-xs">
                loading timeline...
            </div>
        );
    }

    if (!data || data.length === 0) {
        return (
            <div className="h-48 glass-card flex flex-col items-center justify-center text-zinc-500 gap-2">
                <Calendar size={24} className="opacity-50" />
                <span className="text-xs font-mono">No timeline data available</span>
            </div>
        );
    }

    return (
        <div className="glass-card p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-widest flex items-center gap-2 text-zinc-400">
                    <Clock size={14} />
                    Temporal Density
                </h3>
                <span className="text-[10px] bg-white/5 px-2 py-1 rounded font-mono text-zinc-500">
                    Last 24 Hours
                </span>
            </div>

            <div className="flex-1 min-h-[120px] flex items-end gap-1 overflow-x-auto pb-2 custom-scrollbar">
                {data.map((bucket) => {
                    const date = new Date(bucket.timestampMs);
                    const total = Object.values(bucket.counts).reduce((a, b) => a + b, 0);
                    const heightPercent = maxCount > 0 ? (total / maxCount) * 100 : 0;

                    // Simple deterministic color mapping for sectors
                    const getSectorColor = (sector: string) => {
                        switch (sector) {
                            case 'reflective': return 'bg-cyan-500';
                            case 'epistemic': return 'bg-indigo-500';
                            case 'fictional': return 'bg-pink-500';
                            default: return 'bg-zinc-600';
                        }
                    };

                    return (
                        <div key={bucket.bucketKey} className="flex flex-col items-center gap-2 group min-w-[30px] flex-shrink-0">
                            {/* Bar Stack */}
                            <div className="w-4 bg-zinc-800/50 rounded-full overflow-hidden relative flex flex-col-reverse justify-start transition-all duration-300 group-hover:w-6" style={{ height: '100px' }}>
                                {/* Render stacked segments */}
                                {Object.entries(bucket.counts).map(([sector, count]) => {
                                    if (count === 0) return null;
                                    const segmentHeight = (count / total) * (heightPercent); // scaled to bar height relative to max
                                    return (
                                        <div
                                            key={sector}
                                            className={cn("w-full transition-all", getSectorColor(sector))}
                                            style={{ height: `${(count / maxCount) * 100}%` }}
                                            title={`${sector}: ${count}`}
                                        />
                                    );
                                })}
                            </div>

                            {/* Label */}
                            <span className="text-[9px] font-mono text-zinc-600 group-hover:text-zinc-300 transition-colors">
                                {date.getHours()}h
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
