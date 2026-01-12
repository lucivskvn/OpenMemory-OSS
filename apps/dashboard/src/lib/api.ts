import { MemoryClient } from "./client";
import { GraphData, GraphLink, GraphNode, MemoryUpdateParams } from "./types";

// Re-export common types for UI compatibility
export * from "./types";
export * from "./client";

// Rename MemoryItem to Memory for backward compatibility with UI components
import { MemoryItem, TemporalFact } from "openmemory-js/client";
export type Memory = MemoryItem;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

// Initialize singleton client
export const client = new MemoryClient({
    baseUrl: API_URL,
    token: API_KEY
});

/**
 * Standardized error handling wrapper for API calls.
 * Ensures strict typing and logs errors consistently.
 */
async function safeRequest<T>(request: Promise<T>, context: string): Promise<T> {
    try {
        return await request;
    } catch (error: unknown) {
        console.error(`[API] Error in ${context}:`, error);
        // We could also trigger a global toast/notification here if we wire up an event bus
        throw error;
    }
}


// Legacy API wrapper for backward compatibility with existing components
export const api = {
    getStats: () => safeRequest(client.getStats(), "getStats"),

    addBatch: async (items: Array<{ content: string; tags?: string[]; metadata?: Record<string, unknown> }>) =>
        safeRequest(client.addBatch(items), "addBatch"),

    getMemories: async (limit = 20) => safeRequest(client.list(limit), "getMemories"),

    searchMemories: async (query: string) => safeRequest(client.search(query), "searchMemories"),

    getFacts: async (pattern = "%", limit = 100) => safeRequest(client.searchFacts(pattern, "all", limit), "getFacts"),

    updateMemory: async (id: string, updates: MemoryUpdateParams) =>
        safeRequest(client.update(id, updates.content, updates.tags, updates.metadata), "updateMemory"),

    reinforceMemory: async (id: string, boost?: number) => safeRequest(client.reinforce(id, boost), "reinforceMemory"),

    deleteMemory: async (id: string) => safeRequest(client.delete(id), "deleteMemory"),

    getActivity: async (limit = 50) => safeRequest(client.getActivity(limit), "getActivity"),

    getTopMemories: async (limit = 10) => safeRequest(client.getTopMemories(limit), "getTopMemories"),

    // Use native SDK method now
    getTimeline: async (hours = 24) => safeRequest(client.getSystemTimeline(hours), "getTimeline"),

    getMaintenanceStats: async (hours = 24) => safeRequest(client.getMaintenanceStats(hours), "getMaintenanceStats"),

    getMaintenanceLogs: async (limit = 20) => safeRequest(client.getMaintenanceLogs(limit), "getMaintenanceLogs"),

    getHealth: async () => safeRequest(client.health(), "getHealth"),

    getGraphData: async (): Promise<GraphData> => {
        // Fetch recent facts and edges to build the graph
        // Limit both to prevent UI clutter and Performance issues
        const [facts, edges] = await Promise.all([
            client.searchFacts("%", "all", 100),
            client.getEdges({ relationType: "%", limit: 500 })
        ]);

        const nodes: GraphNode[] = [];
        const links: GraphLink[] = [];
        const validNodeSet = new Set<string>();

        // 1. Create Fact Nodes and Entity Links (Hypergraph Projection)
        facts.forEach(f => {
            // Track Fact ID
            if (!validNodeSet.has(f.id)) {
                nodes.push({
                    id: f.id,
                    label: f.predicate, // Fact Node is labeled with the relationship (e.g., "knows")
                    group: "fact",
                    val: 1
                });
                validNodeSet.add(f.id);
            }

            // Track Entities
            [f.subject, f.object].forEach(ent => {
                if (!validNodeSet.has(ent)) {
                    nodes.push({
                        id: ent,
                        label: ent,
                        group: "entity",
                        val: 2 // Entities are bigger
                    });
                    validNodeSet.add(ent);
                }
            });

            // Link Entity -> Fact (Subject)
            links.push({
                source: f.subject,
                target: f.id,
                label: "subject",
                confidence: 1
            });

            // Link Fact -> Entity (Object)
            links.push({
                source: f.id,
                target: f.object,
                label: "object", // Arrow points to object
                confidence: 1
            });
        });

        // 2. Add Temporal Edges (Fact -> Fact)
        // Only valid if both source/target nodes exist in our current view
        // This prevents "floating edges" or edges to unknown nodes
        edges.forEach(e => {
            if (validNodeSet.has(e.sourceId) && validNodeSet.has(e.targetId)) {
                links.push({
                    source: e.sourceId,
                    target: e.targetId,
                    label: e.relationType,
                    confidence: e.weight || 0.8
                });
            }
        });

        return { nodes, links };
    }
};

export class ApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ApiError";
    }
}

