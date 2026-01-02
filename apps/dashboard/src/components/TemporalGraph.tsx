"use client";
import { useEffect, useState, useRef } from "react";
import dynamic from "next/dynamic";
import { api, GraphData, GraphNode } from "../lib/api";
import { Brain } from "lucide-react";

// Dynamic import for No-SSR to avoid canvas issues
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
    ssr: false,
    loading: () => <div className="text-gray-500 animate-pulse">Loading Graph Engine...</div>
});

/**
 * Visualization component for Temporal Knowledge Graph.
 * Uses `react - force - graph - 2d` to render nodes (entities) and links (predicates).
 * 
 * @component
 */
export const TemporalGraph = () => {
    const [data, setData] = useState<GraphData>({ nodes: [], links: [] });
    const [dimensions, setDimensions] = useState({ w: 800, h: 400 });
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Load real graph data
        api.getGraphData().then(setData).catch(console.error);

        // Resize handler
        const resize = () => {
            if (containerRef.current) {
                setDimensions({
                    w: containerRef.current.clientWidth,
                    h: containerRef.current.clientHeight
                });
            }
        };

        window.addEventListener('resize', resize);
        resize();

        return () => window.removeEventListener('resize', resize);
    }, []);

    const hasData = data.nodes.length > 0;

    return (
        <div className="lg:col-span-2 glass-card h-[400px] flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold flex items-center gap-2">
                    <Brain className="text-primary" size={20} />
                    Knowledge Graph
                </h2>
                <div className="text-xs text-gray-500 flex gap-4">
                    <span>Nodes: {data.nodes.length}</span>
                    <span>Edges: {data.links.length}</span>
                </div>
            </div>

            <div
                ref={containerRef}
                className="flex-1 rounded-xl bg-black/40 border border-white/5 overflow-hidden relative"
            >
                {!hasData ? (
                    <div className="absolute inset-0 flex items-center justify-center text-gray-500 italic">
                        No graph nodes found yet.
                    </div>
                ) : (
                    <ForceGraph2D
                        width={dimensions.w}
                        height={dimensions.h}
                        graphData={data}
                        nodeLabel="label"
                        nodeColor={() => "#4f46e5"}
                        nodeRelSize={6}
                        linkColor={() => "rgba(255,255,255,0.2)"}
                        backgroundColor="transparent"
                        enableNodeDrag={true}
                        cooldownTicks={100}
                        onNodeClick={(node: any) => {
                            // Cast to GraphNode if customization needed, usually handled by library wrapper
                            const n = node as GraphNode;
                            console.log("Clicked node", n.id);
                        }}
                    />
                )}
            </div>
        </div>
    );
};
