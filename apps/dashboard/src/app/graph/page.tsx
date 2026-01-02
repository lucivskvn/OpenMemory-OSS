"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import Link from "next/link";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";

// Dynamically import ForceGraph2D to avoid SSR issues
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
    ssr: false,
    loading: () => <div className="flex items-center justify-center h-full text-zinc-500">Loading Visualization...</div>
});

interface GraphNode {
    id: string;
    label: string;
    // Add other props if needed
}

interface GraphLink {
    source: string;
    target: string;
    label: string;
    confidence: number;
}

export default function GraphPage() {
    const [data, setData] = useState<{ nodes: GraphNode[], links: GraphLink[] }>({ nodes: [], links: [] });
    const [loading, setLoading] = useState(true);
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const graphRef = useRef<any>();

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
        // Resize handler or other cleanups
    }, [fetchData]);

    const handleNodeClick = useCallback((node: any) => {
        setSelectedNode(node.id);
        // Center camera on node
        if (graphRef.current) {
            graphRef.current.centerAt(node.x, node.y, 1000);
            graphRef.current.zoom(2, 2000);
        }
    }, []);

    return (
        <div className="flex h-screen w-full bg-black text-zinc-100 overflow-hidden relative">
            {/* Header / Nav Overlay */}
            <div className="absolute top-4 left-4 z-10 flex items-center gap-4 pointer-events-none">
                <Link href="/" className="pointer-events-auto p-2 bg-zinc-900/80 backdrop-blur rounded-lg border border-zinc-800 hover:bg-zinc-800 transition-colors">
                    <ArrowLeft className="w-5 h-5" />
                </Link>
                <div className="px-4 py-2 bg-zinc-900/80 backdrop-blur rounded-lg border border-zinc-800">
                    <h1 className="font-semibold text-sm">Knowledge Graph</h1>
                </div>
            </div>

            {/* Controls */}
            <div className="absolute top-4 right-4 z-10 pointer-events-auto">
                <button
                    onClick={fetchData}
                    disabled={loading}
                    className="p-2 bg-zinc-900/80 backdrop-blur rounded-lg border border-zinc-800 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
                </button>
            </div>

            {/* Main Graph Area */}
            <div className="flex-1 h-full w-full">
                <ForceGraph2D
                    ref={graphRef}
                    graphData={data}
                    nodeLabel="label"
                    nodeColor={() => "#6366f1"} // Indigo-500
                    nodeRelSize={6}
                    linkColor={() => "#4b5563"} // Zinc-600
                    linkWidth={link => (link as any).confidence * 2}
                    linkDirectionalArrowLength={3.5}
                    linkDirectionalArrowRelPos={1}
                    onNodeClick={handleNodeClick}
                    backgroundColor="#09090b" // Zinc-950
                />
            </div>

            {/* Sidebar Details (Slide-over) */}
            {selectedNode && (
                <div className="absolute right-0 top-0 h-full w-80 bg-zinc-900/90 backdrop-blur-xl border-l border-zinc-800 p-6 shadow-2xl z-20 transition-transform transform translate-x-0">
                    <div className="flex justify-between items-start mb-6">
                        <h2 className="text-xl font-bold text-indigo-400 break-words">{selectedNode}</h2>
                        <button
                            onClick={() => setSelectedNode(null)}
                            className="text-zinc-500 hover:text-zinc-300"
                        >
                            ✕
                        </button>
                    </div>

                    <div className="space-y-4">
                        <div className="p-4 bg-zinc-950/50 rounded-lg border border-zinc-800">
                            <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Node Type</h3>
                            <p className="text-sm">Entity / Subject</p>
                        </div>

                        <div className="p-4 bg-zinc-950/50 rounded-lg border border-zinc-800">
                            <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Connected</h3>
                            <div className="text-sm space-y-2">
                                {data.links
                                    .filter((l: any) => l.source.id === selectedNode || l.target.id === selectedNode)
                                    .slice(0, 10)
                                    .map((l: any, idx) => (
                                        <div key={idx} className="flex items-center gap-2">
                                            <span className="text-zinc-400">
                                                {l.source.id === selectedNode ? "→" : "←"}
                                            </span>
                                            <span className="text-amber-500 text-xs">{l.label}</span>
                                            <span className="truncate">
                                                {l.source.id === selectedNode ? l.target.id : l.source.id}
                                            </span>
                                        </div>
                                    ))
                                }
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
