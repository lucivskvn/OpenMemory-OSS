"use client";
import React from "react";
import { cn } from "@/lib/utils";
import type { ActivityItem } from "@/lib/types";

interface ActivityFeedProps {
    activities: ActivityItem[];
}

const ACTIVITY_COLORS: Record<string, string> = {
    memory_created: "bg-green-500/10 text-green-400 border border-green-500/20",
    memory_updated: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
    reflection: "bg-purple-500/10 text-purple-400 border border-purple-500/20",
    decay: "bg-red-500/10 text-red-400 border border-red-500/20",
    default: "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"
};

export const ActivityFeed: React.FC<ActivityFeedProps> = ({ activities }) => {
    if (!activities.length) {
        return (
            <div className="glass-card p-8 text-center text-zinc-500 italic text-sm">
                No recent activity recorded.
            </div>
        );
    }

    return (
        <div className="glass-card flex flex-col gap-4 max-h-[400px]">
            <h2 className="text-xl font-bold px-1 border-b border-white/5 pb-2 flex justify-between items-center">
                <span>System Activity</span>
                <span className="text-[10px] bg-white/5 px-2 py-1 rounded-full text-zinc-500 font-bold uppercase tracking-widest">Real-time</span>
            </h2>
            <div className="flex-1 overflow-y-auto pr-2 flex flex-col gap-3 custom-scrollbar">
                {activities.map((item) => (
                    <div
                        key={item.id}
                        className="bg-white/5 hover:bg-white/10 p-4 rounded-xl transition-all border-l-4 border-transparent hover:border-primary group cursor-default"
                    >
                        <div className="flex justify-between items-start mb-2">
                            <span className={cn(
                                "text-[10px] uppercase tracking-widest font-black px-2 py-1 rounded-md",
                                ACTIVITY_COLORS[item.type] || ACTIVITY_COLORS.default
                            )}>
                                {formatType(item.type)}
                            </span>
                            <span className="text-[10px] font-bold text-zinc-600 group-hover:text-zinc-400 transition-colors">
                                {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                        </div>
                        <div className="text-sm text-zinc-300 font-medium mb-2 line-clamp-2 leading-relaxed">
                            &quot;{item.content || "No content available"}&quot;
                        </div>
                        <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-tighter text-zinc-500">
                            <span className="text-zinc-600">{item.sector}</span>
                            <span className="w-1 h-1 bg-zinc-800 rounded-full" />
                            <span>Salience: <span className="text-zinc-400">{item.salience.toFixed(2)}</span></span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

function formatType(type: string): string {
    return type
        .split("_")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}
