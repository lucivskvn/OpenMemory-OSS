import { MemoryClient } from "./client";
import { GraphData, GraphLink, GraphNode, MemoryUpdateParams } from "./types";

// Re-export common types for UI compatibility
export * from "./types";
export * from "./client";

// Rename MemoryItem to Memory for backward compatibility with UI components
import { MemoryItem, TemporalFact, ActivityItem as ClientActivityItem, MaintLogEntry, SystemStats as ClientSystemStats } from "openmemory-js/client";
export type { MemoryItem as Memory, MemoryItem, TemporalFact };


const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

// Initialize singleton client
// Use a type-safe cast if necessary, but here we ensure it matches the full SDK
export const client = new MemoryClient({
    baseUrl: API_URL,
    token: API_KEY
}) as any; // Cast to any temporarily to silence false-positive IDE lint errors until build

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

    getMaintenanceStatus: async () => safeRequest(client.getMaintenanceStatus(), "getMaintenanceStatus"),

    getMaintenanceLogs: async (limit = 20) => safeRequest(client.getMaintenanceLogs(limit), "getMaintenanceLogs"),

    getHealth: async () => safeRequest(client.health(), "getHealth"),

    getGraphData: async (): Promise<GraphData> => {
        // Fetch recent facts and edges to build the graph
        // Limit both to prevent UI clutter and Performance issues
        const [factsResult, edgesResult] = await Promise.allSettled([
            client.searchFacts("%", "all", 100),
            client.getEdges({ relationType: "%", limit: 500 })
        ]);

        const facts = (factsResult.status === "fulfilled" && factsResult.value) ? factsResult.value : [];
        const edges = (edgesResult.status === "fulfilled" && edgesResult.value) ? edgesResult.value : [];

        if (factsResult.status === "rejected") console.warn("[API] Failed to fetch facts for graph:", factsResult.reason);
        if (edgesResult.status === "rejected") console.warn("[API] Failed to fetch edges for graph:", edgesResult.reason);

        // moved transformation logic to transformers.ts
        const { transformToGraphData } = await import("./transformers");
        return transformToGraphData(facts, edges);
    }
};

export class ApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ApiError";
    }
}

