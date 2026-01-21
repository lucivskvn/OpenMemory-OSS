/**
 * @file System, Dashboard, and Health types.
 */

import type { SectorStat, SectorConfig } from "./primitives";
export type { SectorStat, SectorConfig };

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
    counts: {
        memories: number;
        vectors: number;
        facts: number;
        edges: number;
    };
    system: {
        memoryUsage: number;
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
        embedModel: string;
        embedKind: string;
    };
}

export interface SystemMetrics {
    memory: {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
    };
    cpu: {
        user: number;
        system: number;
    };
    uptime: number;
    connections: {
        active: number;
        pool: Record<string, unknown>;
    };
    jobs: {
        active: number;
        names: string[];
    };
    version: string;
}

/**
 * Health check response with system metadata.
 */
export interface HealthResponse {
    success: boolean;
    status: string;
    version: string;
    uptime: number;
    timestamp: number;
    config: {
        vectorBackend: string;
        metadataBackend: string;
        encryptionEnabled: boolean;
    };
}

export interface ActivityItem {
    id: string;
    type: string;
    sector: string;
    content: string;
    salience: number;
    timestamp: number;
}

export type ActivityEntry = ActivityItem;

export interface TopMemory {
    id: string;
    content: string;
    sector: string;
    salience: number;
    lastSeen: number;
}

export interface TimelineBucket {
    primarySector: string;
    label: string;
    sortKey: string;
    count: number;
    hour: string;
}

export interface SystemTimelineBucket {
    bucketKey: string;
    timestampMs: number;
    counts: Record<string, number>;
}

export interface MaintenanceStatus {
    ok: boolean;
    activeJobs: string[];
    count: number;
}

export interface MaintenanceOpStat {
    hour: string;
    decay: number;
    reflection: number;
    consolidation: number;
}

export interface MaintenanceStats {
    total: number;
    by_op: Record<string, number>;
    timeline: MaintenanceOpStat[];
}


export interface SectorsResponse {
    sectors: string[];
    configs: Record<string, SectorConfig>;
    stats: SectorStat[];
}

export interface LogEntry {
    id: string;
    model: string;
    status: string;
    ts: number;
    err: string | null;
    userId?: string | null;
}

export interface MaintLogEntry {
    id: number;
    op: string;
    status: string;
    details: string;
    ts: number;
    userId: string | null;
}

export interface DashboardTopMemory {
    id: string;
    content: string;
    primarySector: string;
    salience: number;
    lastSeenAt: number;
}

export interface DashboardTimelineEntry {
    primarySector: string;
    label: string;
    sortKey: string;
    count: number;
}

export interface EmbedLogParams {
    id: string;
    userId?: string | null;
    model: string;
    status: string;
    ts: number;
    err?: string | null;
}

export interface MaintLogParams {
    op: string;
    userId?: string | null;
    status: string;
    details: string;
    ts: number;
}

export interface RateLimitUpdateParams {
    key: string;
    windowStart: number;
    count: number;
    cost: number;
    lastRequest: number;
}
