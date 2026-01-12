"use client";
import { useEffect, useState, useRef } from "react";
import dynamic from "next/dynamic";
import { api, GraphData, GraphNode, GraphLink } from "../lib/api";
import { Brain } from "lucide-react";

// Dynamic import for No-SSR to avoid canvas issues
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
    ssr: false,
    loading: () => <div className="text-gray-500 animate-pulse">Loading Graph Engine...</div>
});

interface TemporalGraphProps {
    data: GraphData;
    onNodeClick?: (node: GraphNode) => void;
}

/**
 * Visualization component for Temporal Knowledge Graph.
 * Uses `react-force-graph-2d` to render nodes (entities) and links (predicates).
 * 
 * @component
 */
export const TemporalGraph = ({ data, onNodeClick }: TemporalGraphProps) => {
    const [dimensions, setDimensions] = useState({ w: 800, h: 600 });
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const updateDimensions = () => {
            if (containerRef.current) {
                setDimensions({
                    w: containerRef.current.clientWidth,
                    h: containerRef.current.clientHeight
                });
            }
        };

        const resizeObserver = new ResizeObserver(() => {
            updateDimensions();
        });

        if (containerRef.current) {
            resizeObserver.observe(containerRef.current);
            updateDimensions();
        }

        return () => resizeObserver.disconnect();
    }, []);

    const hasData = data && data.nodes && data.nodes.length > 0;

    return (
        <div
            ref={containerRef}
            className="w-full h-full min-h-[300px] relative bg-black/40"
        >
            {!hasData ? (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500 italic">
                    Waiting for data...
                </div>
            ) : (
                <ForceGraph2D
                    width={dimensions.w}
                    height={dimensions.h}
                    graphData={data}
                    nodeLabel="label"
                    nodeColor={(node: object) => {
                        const n = node as GraphNode;
                        if (n.group === "entity") return "#06b6d4";
                        if (n.group === "fact") return "#a855f7";
                        return "#64748b";
                    }}
                    nodeRelSize={6}
                    linkColor={(link: object) => {
                        const l = link as GraphLink;
                        if (l.label === "subject" || l.label === "object") return "rgba(255, 255, 255, 0.2)";
                        return "#f43f5e";
                    }}
                    linkWidth={(link: object) => {
                        const l = link as GraphLink;
                        return (l.label === "subject" || l.label === "object") ? 1 : 2;
                    }}
                    linkDirectionalParticles={(link: object) => ((link as GraphLink).label === "subject" || (link as GraphLink).label === "object") ? 0 : 4}
                    linkDirectionalParticleSpeed={0.005}
                    backgroundColor="transparent"
                    enableNodeDrag={true}
                    cooldownTicks={100}
                    onNodeClick={(node: object) => {
                        const n = node as GraphNode;
                        if (onNodeClick) onNodeClick(n);
                    }}
                />
            )}
        </div>
    );
};
