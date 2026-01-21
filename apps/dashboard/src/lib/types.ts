/**
 * @file Master type definitions for the OpenMemory ecosystem (Dashboard Client Version).
 * Synchronized with packages/openmemory-js.
 */

// Re-export everything from the SDK
export * from "openmemory-js/client";

// Import specific types for aliasing/extending
// Import specific types for aliasing/extending
import type {
    TimelineBucket,
    MemoryRow,
    SectorType,
    MemoryItem,
    IngestRequest,
    IngestUrlRequest,
    SystemStats,
    ActivityItem,
    OpenMemoryEvent,
    MaintLogEntry,
    SourceRegistryEntry,
    MaintenanceStatus,
    AddMemoryRequest,
    AuditLogEntry,
    WaypointGraphResult,
    ApiKey
} from "openmemory-js/client";

export interface UserProfile {
    id: string;
    username: string;
    email?: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
}

export interface AuditStats {
    total: number;
    totalEvents: number;
    criticalEvents: number;
    byAction: Record<string, number>;
    byResourceType: Record<string, number>;
    lastEntryAt: number;
}

export type {
    SystemStats,
    ActivityItem,
    OpenMemoryEvent,
    MaintLogEntry,
    SourceRegistryEntry,
    MaintenanceStatus,
    AuditLogEntry,
    WaypointGraphResult,
    ApiKey
};

// --- Dashboard Specific (Legacy or UI) ---

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
    weight?: number;
}

export interface GraphData {
    nodes: GraphNode[];
    links: GraphLink[];
}

// Visual alias
export type TimelineItem = TimelineBucket;

// --- Backward Compatibility Aliases ---
// These are kept to avoid breaking existing UI components that might import these names.
export interface MemoryUpdateParams {
    content?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
}

export type MemRow = MemoryRow;
export type IngestReq = IngestRequest;
export type IngestUrlReq = IngestUrlRequest;

// Match SDK exactly
export type ClientMemoryOptions = Partial<AddMemoryRequest>;
