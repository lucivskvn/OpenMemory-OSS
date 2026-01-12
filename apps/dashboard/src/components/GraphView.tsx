"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import Link from "next/link";
import { ArrowLeft, Loader2, RefreshCw, Layers, Database, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { GraphNode, GraphLink } from "@/lib/types";

// Helper type for D3-augmented nodes
type VisualNode = GraphNode & { x?: number; y?: number };
type VisualLink = GraphLink & {
    source: string | VisualNode;
    target: string | VisualNode;
};

// Dynamically import ForceGraph2D to avoid SSR issues
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
    ssr: false,
    loading: () => (
        <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4">
            <Loader2 className="animate-spin text-primary" size={32} />
            <span className="text-[10px] font-black uppercase tracking-[0.2em]">Initializing Engine</span>
        </div>
    )
});

export function GraphView() {
    const [data, setData] = useState<{ nodes: GraphNode[], links: GraphLink[] }>({ nodes: [], links: [] });
    const [loading, setLoading] = useState(true);
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const graphRef = useRef<any>(null); // Use existing any for library ref

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const graphData = await api.getGraphData();
            setData(graphData);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleNodeClick = useCallback((node: any) => {
        // node is VisualNode
        const n = node as VisualNode;
        setSelectedNode(n.id);
        if (graphRef.current) {
            graphRef.current.centerAt(n.x, n.y, 1000);
            graphRef.current.zoom(2.5, 2000);
        }
    }, []);

    const selectedLinks = data.links.filter(
        (l: any) => {
            const link = l as VisualLink;
            const sId = typeof link.source === 'object' ? (link.source as VisualNode).id : link.source;
            const tId = typeof link.target === 'object' ? (link.target as VisualNode).id : link.target;
            return sId === selectedNode || tId === selectedNode;
        }
    );

    return (
        <div className="flex h-screen w-full bg-[#050505] text-zinc-100 overflow-hidden relative">
            {/* Header / Nav Overlay */}
            <div className="absolute top-6 left-6 z-10 flex items-center gap-4">
                <Link
                    href="/"
                    className="p-3 bg-zinc-900/60 backdrop-blur-2xl rounded-2xl border border-white/5 hover:bg-zinc-800 transition-all shadow-2xl active:scale-95 group"
                >
                    <ArrowLeft className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
                </Link>
                <div className="px-5 py-3 bg-zinc-900/60 backdrop-blur-2xl rounded-2xl border border-white/5 shadow-2xl flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    <div>
                        <h1 className="font-black text-xs uppercase tracking-widest leading-none">Knowledge Graph</h1>
                        <p className="text-[9px] text-zinc-500 font-bold mt-1 uppercase">Neural Adjacency Map</p>
                    </div>
                </div>
            </div>

            {/* Controls */}
            <div className="absolute top-6 right-6 z-10 flex gap-2">
                <button
                    onClick={fetchData}
                    disabled={loading}
                    className="p-3 bg-zinc-900/60 backdrop-blur-2xl rounded-2xl border border-white/5 hover:bg-zinc-800 transition-all shadow-2xl disabled:opacity-50 group"
                >
                    <RefreshCw className={cn("w-5 h-5 text-zinc-400 group-hover:text-white transition-colors", loading && "animate-spin")} />
                </button>
            </div>

            {/* Main Graph Area */}
            <div className="flex-1 h-full w-full cursor-crosshair">
                <ForceGraph2D
                    ref={graphRef}
                    graphData={data}
                    nodeLabel="label"
                    nodeColor={() => "#6366f1"}
                    nodeRelSize={6}
                    linkColor={() => "rgba(255, 255, 255, 0.1)"}
                    linkWidth={(link: any) => ((link as GraphLink).confidence || 0.5) * 3}
                    linkDirectionalArrowLength={4}
                    linkDirectionalArrowRelPos={1}
                    onNodeClick={handleNodeClick}
                    backgroundColor="#050505"
                    nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                        const n = node as VisualNode;
                        const label = n.label;
                        const fontSize = 12 / globalScale;
                        ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;

                        // Draw shadow/glow
                        ctx.shadowColor = "rgba(99, 102, 241, 0.4)";
                        ctx.shadowBlur = 15;

                        // Draw node circle
                        ctx.fillStyle = n.id === selectedNode ? "#818cf8" : "#6366f1";
                        ctx.beginPath();
                        if (n.x !== undefined && n.y !== undefined) {
                            ctx.arc(n.x, n.y, 4, 0, 2 * Math.PI, false);
                            ctx.fill();

                            // Reset shadow
                            ctx.shadowBlur = 0;

                            if (globalScale > 1.5) {
                                ctx.textAlign = "center";
                                ctx.textBaseline = "middle";
                                ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
                                ctx.fillText(label, n.x, n.y + 10);
                            }
                        }
                    }}
                />
            </div>

            {/* Sidebar Details (Slide-over) */}
            <div className={cn(
                "absolute right-0 top-0 h-full w-96 bg-zinc-900/40 backdrop-blur-3xl border-l border-white/5 p-8 shadow-2xl z-20 transition-all duration-500 ease-out flex flex-col gap-8",
                selectedNode ? "translate-x-0 opacity-100" : "translate-x-full opacity-0 pointer-events-none"
            )}>
                <div className="flex justify-between items-start">
                    <div className="flex-1">
                        <span className="text-[10px] font-black text-primary uppercase tracking-[0.2em] mb-2 block">Active Node</span>
                        <h2 className="text-2xl font-black text-white leading-tight break-words">{selectedNode}</h2>
                    </div>
                    <button
                        onClick={() => setSelectedNode(null)}
                        className="p-2 text-zinc-500 hover:text-white bg-white/5 rounded-xl transition-all"
                    >
                        ✕
                    </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                        <div className="text-zinc-500 mb-2"><Layers size={16} /></div>
                        <h3 className="text-[9px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Entity Type</h3>
                        <p className="text-xs font-bold text-zinc-300">Semantic Node</p>
                    </div>
                    <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                        <div className="text-zinc-500 mb-2"><Database size={16} /></div>
                        <h3 className="text-[9px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Connections</h3>
                        <p className="text-xs font-bold text-zinc-300">{selectedLinks.length} Edges</p>
                    </div>
                </div>

                <div className="flex-1 overflow-hidden flex flex-col gap-4">
                    <h3 className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 font-black flex items-center gap-2">
                        <Activity size={14} />
                        Relationship Map
                    </h3>
                    <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-3">
                        {selectedLinks.length === 0 ? (
                            <p className="text-sm text-zinc-600 italic">No significant relationships mapped.</p>
                        ) : (
                            selectedLinks.map((l: any, idx) => {
                                const link = l as VisualLink;
                                const sourceId = typeof link.source === 'object' ? (link.source as VisualNode).id : link.source;
                                const targetId = typeof link.target === 'object' ? (link.target as VisualNode).id : link.target;
                                const isSource = sourceId === selectedNode;
                                const other = isSource ? targetId : sourceId;

                                return (
                                    <div key={idx} className="p-4 bg-black/40 rounded-2xl border border-white/5 hover:border-white/10 transition-all group">
                                        <div className="flex items-center gap-3 mb-2">
                                            <span className={cn(
                                                "text-[9px] px-1.5 py-0.5 rounded font-black uppercase tracking-widest",
                                                isSource ? "bg-emerald-500/10 text-emerald-400" : "bg-blue-500/10 text-blue-400"
                                            )}>
                                                {isSource ? "Outgoing" : "Incoming"}
                                            </span>
                                            <span className="text-[10px] font-mono text-zinc-600 font-bold">Ref: {idx + 1}</span>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-tight italic">{link.label}</span>
                                            <span className="text-sm font-medium text-zinc-300 group-hover:text-white transition-colors break-words">
                                                {other}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>

            {/* Info Badge */}
            <div className="absolute bottom-6 left-6 z-10 p-4 bg-zinc-900/60 backdrop-blur-2xl rounded-2xl border border-white/5 text-[10px] text-zinc-500 font-medium">
                Showing {data.nodes.length} nodes and {data.links.length} relationships
            </div>
        </div>
    );
}
