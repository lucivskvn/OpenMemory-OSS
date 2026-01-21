import { TemporalFact, TemporalEdge } from "openmemory-js/client";
import { GraphData, GraphNode, GraphLink } from "./types";

/**
 * Transforms raw Facts and Edges into a visual graph structure.
 * Projects the hypergraph (Fact -> [Subject, Object]) into a node-link model.
 * 
 * @param facts - List of Temporal Facts
 * @param edges - List of Temporal Edges (Fact-to-Fact relationships)
 * @returns Formatted GraphData for ForceGraph2D
 */
export function transformToGraphData(facts: TemporalFact[], edges: TemporalEdge[]): GraphData {
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const validNodeSet = new Set<string>();

    const addNode = (id: string, label: string, group: string, val: number) => {
        if (!validNodeSet.has(id)) {
            nodes.push({ id, label: label || id, group, val });
            validNodeSet.add(id);
        }
    };

    // 1. Create Fact Nodes and Entity Links (Hypergraph Projection)
    facts.forEach(f => {
        // Fact Node representing the relationship
        addNode(f.id, f.predicate, "fact", 1);

        // Subject Entity
        addNode(f.subject, f.subject, "entity", 2);

        // Object Entity
        addNode(f.object, f.object, "entity", 2);

        // Link Entity -> Fact (Subject)
        links.push({
            source: f.subject,
            target: f.id,
            label: "subject",
            weight: f.confidence || 0.8
        });

        // Link Fact -> Entity (Object)
        links.push({
            source: f.id,
            target: f.object,
            label: "object",
            weight: f.confidence || 0.8
        });
    });

    // 2. Add Temporal Edges (Fact -> Fact) - Meta-knowledge
    edges.forEach(e => {
        if (validNodeSet.has(e.sourceId) && validNodeSet.has(e.targetId)) {
            links.push({
                source: e.sourceId,
                target: e.targetId,
                label: e.relationType,
                weight: e.weight || 0.5
            });
        }
    });

    return { nodes, links };
}
