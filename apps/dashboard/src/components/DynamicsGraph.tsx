"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { client } from "@/lib/api";
import {
    Activity,
    RefreshCw,
    Zap,
    Compass,
    Database,
    Loader2,
    Info
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WaypointGraphResult } from "@/lib/types";

// Dynamically import ForceGraph2D
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
    ssr: false,
    loading: () => (
        <div className="flex flex-col items-center justify-center min-h-[400px] text-zinc-500 gap-4">
            <Loader2 className="animate-spin text-primary" size={32} />
            <span className="text-[10px] font-black uppercase tracking-[0.2em]">Mapping Topology</span>
        </div>
    )
});

export function DynamicsGraph() {
    const [data, setData] = useState<{ nodes: any[], links: any[] }>({ nodes: [], links: [] });
    const [loading, setLoading] = useState(true);
    const graphRef = useRef<any>(null);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const result: WaypointGraphResult = await client.dynamics.getWaypointGraph(100);

            // Map waypoints to graph format
            const nodes = result.nodes.map(n => ({
                id: n.memoryId,
                label: n.memoryId,
                val: (n.edgeCount || 1) * 2,
                color: n.memoryId.startsWith("sector_") ? "#6366f1" : "#f43f5e"
            }));

            const links = result.nodes.flatMap(n =>
                n.connections.map(c => ({
                    source: n.memoryId,
                    target: c.targetId,
                    weight: c.weight
                }))
            );

            setData({ nodes, links });
        } catch (err) {
            console.error("Failed to load dynamics graph:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between px-2">
                <div className="flex items-center gap-4">
                    <div className="p-2.5 bg-primary/10 rounded-xl text-primary">
                        <Compass size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-black text-white uppercase tracking-tight">Waypoint Topology</h2>
                        <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Cognitive sector adjacency & activation flow</p>
                    </div>
                </div>
                <button
                    onClick={fetchData}
                    disabled={loading}
                    className="p-3 bg-white/5 hover:bg-white/10 rounded-xl transition-all disabled:opacity-50"
                >
                    <RefreshCw size={16} className={cn(loading && "animate-spin")} />
                </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                <div className="lg:col-span-3 h-[600px] glass-card p-0 border-white/5 overflow-hidden relative group">
                    <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent pointer-events-none" />

                    <div className="absolute top-4 left-4 z-10 flex gap-2">
                        <div className="px-3 py-1 bg-black/50 backdrop-blur-md rounded-full border border-white/10 flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                            <span className="text-[9px] font-black uppercase text-white tracking-widest">Live Activation Map</span>
                        </div>
                    </div>

                    <ForceGraph2D
                        ref={graphRef}
                        graphData={data}
                        nodeLabel="label"
                        nodeRelSize={6}
                        nodeVal="val"
                        linkColor={() => "rgba(255, 255, 255, 0.05)"}
                        linkWidth={(l: any) => l.weight * 2}
                        backgroundColor="#00000000"
                        nodeCanvasObject={(node: any, ctx, globalScale) => {
                            const label = node.label;
                            const fontSize = 12 / globalScale;
                            ctx.font = `${fontSize}px Inter, sans-serif`;

                            // Glow
                            ctx.shadowBlur = 10;
                            ctx.shadowColor = node.color;

                            // Circle
                            ctx.fillStyle = node.color;
                            ctx.beginPath();
                            ctx.arc(node.x, node.y, 4, 0, 2 * Math.PI, false);
                            ctx.fill();

                            ctx.shadowBlur = 0;

                            if (globalScale > 2) {
                                ctx.textAlign = "center";
                                ctx.textBaseline = "middle";
                                ctx.fillStyle = "white";
                                ctx.fillText(label, node.x, node.y + 10);
                            }
                        }}
                    />
                </div>

                <div className="lg:col-span-1 flex flex-col gap-6">
                    <div className="glass-card border-white/5 p-6 space-y-4">
                        <div className="flex items-center gap-2 text-zinc-400">
                            <Zap size={16} />
                            <h3 className="text-xs font-black uppercase tracking-widest">Dynamics Engine</h3>
                        </div>
                        <p className="text-xs text-zinc-500 font-medium leading-relaxed">
                            Waypoints represent semantic nuclei where memories cluster. The topology shows how activation spreads between these nuclei.
                        </p>

                        <div className="space-y-3 pt-2">
                            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-tight">
                                <span className="text-zinc-500">Node Density</span>
                                <span className="text-white">Optimal</span>
                            </div>
                            <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden">
                                <div className="h-full bg-primary w-2/3" />
                            </div>
                            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-tight">
                                <span className="text-zinc-500">Synaptic Weight</span>
                                <span className="text-white">0.842</span>
                            </div>
                            <div className="w-full h-1 bg-zinc-900 rounded-full overflow-hidden">
                                <div className="h-full bg-emerald-500 w-4/5" />
                            </div>
                        </div>
                    </div>

                    <div className="glass-card border-primary/10 bg-primary/5 p-6 flex flex-col gap-3">
                        <div className="flex items-center gap-2 text-primary">
                            <Database size={16} />
                            <h4 className="text-xs font-black uppercase tracking-widest">Active Sectors</h4>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {["Personal", "Work", "Finance", "Social", "Technical"].map(s => (
                                <span key={s} className="px-2 py-1 bg-white/5 rounded-md text-[9px] font-bold text-zinc-300 uppercase border border-white/5">
                                    {s}
                                </span>
                            ))}
                        </div>
                    </div>

                    <div className="mt-auto p-4 bg-zinc-900/40 border border-white/5 rounded-2xl flex items-start gap-3">
                        <Info size={14} className="text-zinc-600 shrink-0 mt-0.5" />
                        <p className="text-[9px] text-zinc-600 font-bold leading-normal italic">
                            Spatial positioning is determined by force-directed semantic relatedness metrics.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
