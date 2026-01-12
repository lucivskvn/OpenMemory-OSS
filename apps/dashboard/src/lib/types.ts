/**
 * @file Master type definitions for the OpenMemory ecosystem (Dashboard Client Version).
 * Synchronized with packages/openmemory-js.
 */

// Re-export everything from the SDK
export * from "openmemory-js/client";

// Import specific types for aliasing/extending
import type { TimelineBucket, MemoryRow, SectorType, MemoryItem, IngestRequest, IngestUrlRequest, SystemStats, ActivityItem, OpenMemoryEvent, MaintLogEntry, SourceRegistryEntry } from "openmemory-js/client";
export type { SystemStats, ActivityItem, OpenMemoryEvent, MaintLogEntry, SourceRegistryEntry };

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
    confidence?: number;
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

// Ensure ClientMemoryOptions is available if not exported by *
export interface ClientMemoryOptions {
    userId?: string;
    tags?: string[];
    [key: string]: unknown;
}
