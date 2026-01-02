const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

// Manual sync with packages/openmemory-js/src/core/types.ts -> MemoryItem
// Note: api.ts must be robust to slight server variances
export interface Memory {
    id: string;
    content: string;
    user_id?: string | null;
    primary_sector: string;
    salience: number;
    metadata?: Record<string, any>;
    tags?: string[];
    updated_at: number;
    created_at: number;
    last_seen_at: number;
    decay_lambda: number;
    version: number;
    mean_dim?: number;
    mean_vec?: any;
    compressed_vec?: any;
    compressed_vec_str?: string;
    feedback_score?: number;
}

export interface SystemStats {
    totalMemories: number;
    recentMemories: number;
    sectorCounts: Record<string, number>;
    avgSalience: string;
    decayStats: {
        total: number;
        avgLambda: string;
        minSalience: string;
        maxSalience: string;
    };
    requests: {
        total: number;
        errors: number;
        errorRate: string;
        lastHour: number;
    };
    qps: {
        peak: number;
        average: number;
        cacheHitRate: number;
    };
    system: {
        memoryUsage: number; // dbpct
        heapUsed: number;
        heapTotal: number;
        uptime: {
            seconds: number;
            days: number;
            hours: number;
        };
    };
    config: {
        port: number;
        vecDim: number;
        cacheSegments: number;
        maxActive: number;
        decayInterval: number;
        embedProvider: string;
    };
}

export class ApiError extends Error {
    public code: string;
    public details?: any;

    constructor(message: string, code: string = "UNKNOWN_ERROR", details?: any) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

async function handleResponse<T>(res: Response): Promise<T> {
    if (res.ok) {
        // Some endpoints return 204 No Content
        if (res.status === 204) return {} as T;
        return res.json();
    }

    let errorData: any;
    try {
        errorData = await res.json();
    } catch {
        // Fallback if not JSON
        throw new ApiError(`Request failed: ${res.statusText} (${res.status})`);
    }

    if (errorData?.error) {
        const { code, message, details } = errorData.error;
        throw new ApiError(message || "Unknown server error", code, details);
    }

    throw new ApiError(`Request failed with status ${res.status}`);
}

export const api = {
    async getStats(): Promise<SystemStats> {
        const res = await fetch(`${API_URL}/dashboard/stats`, {
            headers: { "x-api-key": API_KEY }
        });
        return handleResponse<SystemStats>(res);
    },

    async getMemories(limit = 20): Promise<Memory[]> {
        // Server route is /memory/all?l=limit
        const res = await fetch(`${API_URL}/memory/all?l=${limit}`, {
            headers: { "x-api-key": API_KEY }
        });
        const json = await handleResponse<{ items: Memory[] }>(res);
        return json.items;
    },

    async searchMemories(query: string): Promise<Memory[]> {
        // Server route is /memory/query (POST)
        const res = await fetch(`${API_URL}/memory/query`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": API_KEY
            },
            body: JSON.stringify({ query })
        });
        const json = await handleResponse<{ matches: Memory[] }>(res);
        return json.matches;
    },

    async getFacts(pattern: string = "%", limit = 100): Promise<TemporalFact[]> {
        const url = `${API_URL}/api/temporal/search?pattern=${encodeURIComponent(pattern)}&limit=${limit}`;
        const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
        const json = await handleResponse<{ facts: TemporalFact[] }>(res);
        return json.facts;
    },

    async updateMemory(id: string, updates: Partial<Memory>): Promise<Memory> {
        const res = await fetch(`${API_URL}/memory/${id}`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": API_KEY
            },
            body: JSON.stringify(updates)
        });
        return handleResponse<Memory>(res);
    },

    async reinforceMemory(id: string, boost?: number): Promise<void> {
        const res = await fetch(`${API_URL}/memory/reinforce`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": API_KEY
            },
            body: JSON.stringify({ id, boost })
        });
        return handleResponse<void>(res);
    },

    async deleteMemory(id: string): Promise<void> {
        const res = await fetch(`${API_URL}/memory/${id}`, {
            method: "DELETE",
            headers: { "x-api-key": API_KEY }
        });
        return handleResponse<void>(res);
    },

    async getGraphData(): Promise<GraphData> {
        // Fetch recent/all facts to build the graph
        const facts = await this.getFacts("%", 200);

        // Extract unique nodes
        const nodeSet = new Set<string>();
        facts.forEach(f => {
            nodeSet.add(f.subject);
            nodeSet.add(f.object);
        });

        const nodes: GraphNode[] = Array.from(nodeSet).map(id => ({ id, label: id }));
        const links: GraphLink[] = facts.map(f => ({
            source: f.subject,
            target: f.object,
            label: f.predicate,
            confidence: f.confidence
        }));

        return { nodes, links };
    }
};

export interface TemporalFact {
    id: string;
    user_id?: string | null;
    subject: string;
    predicate: string;
    object: string;
    valid_from: string | number;
    valid_to: string | number | null;
    confidence: number;
    source_id?: string;
    last_updated?: string | number;
    metadata?: Record<string, any>;
}

export interface TemporalEdge {
    id: string;
    user_id?: string | null;
    source_id: string;
    target_id: string;
    relation_type: string;
    valid_from: string | number;
    valid_to: string | number | null;
    weight: number;
    metadata?: Record<string, any>;
}

export interface GraphNode {
    id: string;
    label: string;
    group?: string;
    val?: number;
}

export interface GraphLink {
    source: string;
    target: string;
    label: string;
    confidence: number;
}

export interface GraphData {
    nodes: GraphNode[];
    links: GraphLink[];
}
