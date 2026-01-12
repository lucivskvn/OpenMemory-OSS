"use client";

import { api } from "@/lib/api";
import { toast } from "sonner";
import { StatsGrid } from "@/components/StatsGrid";
import { MemoryCard } from "@/components/MemoryCard";
import { TemporalGraph } from "@/components/TemporalGraph";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Timeline } from "@/components/Timeline";
import { MaintenanceFeed } from "@/components/MaintenanceFeed";
import { StatsSkeleton, MemorySkeleton } from "@/components/Skeleton";
import { useDashboardData } from "@/lib/hooks/use-dashboard-data";
import { useState, useMemo } from "react";
import { BrainCircuit, Filter, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function DashboardView() {
    const { stats, recent, activity, logs, graphData, timeline, loading, error } = useDashboardData();
    const [selectedNode, setSelectedNode] = useState<string | null>(null);

    const handleReinforce = (id: string) => {
        api.reinforceMemory(id)
            .then(() => toast.success("Memory reinforced"))
            .catch(() => toast.error("Failed to reinforce memory"));
    };

    // Filtered data based on graph selection
    const filteredActivity = useMemo(() => {
        if (!selectedNode) return activity;
        return activity.filter(a =>
            a.content.toLowerCase().includes(selectedNode.toLowerCase()) ||
            a.sector.toLowerCase().includes(selectedNode.toLowerCase())
        );
    }, [activity, selectedNode]);

    const filteredRecent = useMemo(() => {
        if (!selectedNode) return recent;
        return recent.filter(m =>
            m.content.toLowerCase().includes(selectedNode.toLowerCase()) ||
            m.primarySector.toLowerCase().includes(selectedNode.toLowerCase())
        );
    }, [recent, selectedNode]);

    return (
        <div className="flex flex-col gap-10 animate-in fade-in duration-700">
            {error && (
                <div className="fixed top-24 right-8 z-[100] glass-card border-red-500/20 bg-red-500/10 px-6 py-4 rounded-2xl flex items-center gap-4 animate-in slide-in-from-right-10">
                    <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <p className="text-sm font-bold text-red-200">{error}</p>
                    <button onClick={() => window.location.reload()} className="text-[10px] font-black uppercase tracking-widest bg-red-500/20 px-2 py-1 rounded hover:bg-red-500/40 transition-colors">Reconnect</button>
                </div>
            )}

            <section>
                {loading && !stats ? <StatsSkeleton /> : <StatsGrid stats={stats} />}
            </section>

            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    <div className="p-2.5 bg-primary/10 rounded-xl text-primary shadow-inner">
                        <BrainCircuit size={24} />
                    </div>
                    <div>
                        <h2 className="text-2xl font-black tracking-tight text-white leading-none">Neural Adjacency Explorer</h2>
                        <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1.5 flex items-center gap-2">
                            Interactive Knowledge Visualization
                        </p>
                    </div>
                </div>

                {selectedNode && (
                    <div className="flex items-center gap-3 px-4 py-2 bg-primary/10 border border-primary/20 rounded-2xl text-[10px] font-black uppercase tracking-widest text-primary animate-in zoom-in duration-300 shadow-lg shadow-primary/5">
                        <Filter size={12} />
                        <span>Filter: <strong className="text-white">{selectedNode}</strong></span>
                        <button
                            onClick={() => setSelectedNode(null)}
                            className="bg-primary/20 hover:bg-primary/40 p-1 rounded-md transition-all ml-2"
                        >
                            <X size={10} />
                        </button>
                    </div>
                )}
            </div>

            <main className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                <div className="lg:col-span-8 h-[600px] glass-card p-0 border-white/5 overflow-hidden group relative">
                    <div className="absolute top-4 left-4 z-10 pointer-events-none">
                        <span className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-600">Spatial Topology</span>
                    </div>
                    <TemporalGraph
                        data={graphData}
                        onNodeClick={(node) => setSelectedNode(node.id)}
                    />
                </div>

                <div className="lg:col-span-4 flex flex-col gap-8">
                    <ActivityFeed activities={filteredActivity} />
                    <Timeline data={timeline} isLoading={loading} />
                    <MaintenanceFeed logs={logs} />
                </div>
            </main>

            <section className="glass-card border-white/5">
                <div className="flex items-center justify-between mb-8 border-b border-white/5 pb-4">
                    <div>
                        <h2 className="text-xl font-black text-white italic tracking-tight uppercase">
                            {selectedNode ? `Relevant Sub-Memories` : "Primary Knowledge Stream"}
                        </h2>
                        <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">
                            {selectedNode ? `Neural clusters matching "${selectedNode}"` : "Most recent semantic records"}
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    {loading && filteredRecent.length === 0 ? (
                        [...Array(6)].map((_, i) => <MemorySkeleton key={i} />)
                    ) : (
                        filteredRecent.map((mem) => (
                            <MemoryCard
                                key={mem.id}
                                memory={mem}
                                onReinforce={handleReinforce}
                            />
                        ))
                    )}
                    {!loading && filteredRecent.length === 0 && (
                        <div className="col-span-full text-center py-20 glass-card border-dashed border-white/10 opacity-60">
                            <p className="text-sm font-medium text-zinc-500 italic uppercase tracking-widest">
                                {selectedNode ? "No specific patterns identified." : "Neural stream empty."}
                            </p>
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
