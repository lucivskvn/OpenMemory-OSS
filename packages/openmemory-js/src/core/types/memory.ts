/**
 * @file Base and Core Memory types.
 */

// Import SectorType specifically to avoid index barrel during initialization
import type { SectorType } from "./primitives";

/**
 * Result of an embedding operation.
 */
export interface EmbeddingResult {
    sector: string;
    vector: number[];
    dim: number;
}

/**
 * Standard request for adding a new memory.
 */
export interface AddMemoryRequest {
    /** The actual content of the memory */
    content: string;
    /** Optional tags for categorization */
    tags?: string[];
    /** Structured metadata */
    metadata?: Record<string, unknown>;
    /** Initial salience (importance) score (0-1) */
    salience?: number;
    /** Frequency of decay for this memory */
    decayLambda?: number;
    /** Owner of the memory or 'null' for anonymous */
    userId?: string | null;
    /** Optional explicit ID (for migration/restore) */
    id?: string;
    /** Optional creation timestamp (for migration/restore) */
    createdAt?: number;
}

/**
 * Request for batch memory insertion.
 */
export interface BatchAddRequest {
    items: AddMemoryRequest[];
    userId?: string | null;
}

/**
 * Semantic search request with optional filtering.
 */
export interface QueryMemoryRequest {
    /** Natural language or keyword query */
    query: string;
    /** Number of results to return */
    k?: number;
    /** Filtering criteria */
    filters?: {
        /** Search only memories with these tags */
        tags?: string[];
        /** Minimum similarity/relevance score */
        minScore?: number;
        /** Specific sector to search in */
        sector?: SectorType | string;
        /** Filter by owner */
        userId?: string | null;
        /** Start timestamp for temporal filtering */
        startTime?: number;
        /** End timestamp for temporal filtering */
        endTime?: number;
    };
    /** Global user context for the query (Anonymous if null, System if undefined) */
    userId?: string | null;
}

/**
 * Database representation of a memory row.
 */
export interface MemoryRow {
    id: string;
    content: string;
    primarySector: string;
    tags: string | null;
    metadata: string | null;
    userId: string | null;
    segment: number;
    simhash: string | null;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    salience: number;
    decayLambda: number;
    version: number;
    generatedSummary: string | null;
    meanDim?: number;
    meanVec?: Uint8Array | number[] | null;
    compressedVec?: Uint8Array | number[] | null;
    feedbackScore?: number;
    encryptionKeyVersion?: number;
    coactivations?: number;
}

/**
 * Hydrated memory object used in business logic and APIs.
 */
export interface MemoryItem {
    id: string;
    content: string;
    primarySector: string;
    userId: string | null;
    segment: number;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    salience: number;
    decayLambda: number;
    version: number;
    generatedSummary: string | null;
    encryptionKeyVersion?: number;
    coactivations?: number;
    tags: string[];
    metadata: Record<string, unknown>;
    simhash: string | null;
    sectors?: string[];
    compressedVecStr?: string;
    chunks?: number;
}

export interface BatchMemoryInsertItem extends Omit<MemoryRow, "tags" | "metadata" | "meanVec" | "compressedVec"> {
    tags: string | null;
    metadata: string | null;
    meanDim: number;
    meanVec: Uint8Array | number[];
    compressedVec: Uint8Array | number[];
    feedbackScore: number;
}

export interface IdePattern {
    patternId: string;
    description: string;
    salience: number;
    detectedAt: number;
    lastReinforced: number;
    confidence?: number;
    affectedFiles?: string[];
}

/**
 * Standardized metadata for IDE-related memories.
 */
export interface IdeMetadata {
    ideProjectName?: string;
    ide_project_name?: string;
    language?: string;
    ideFilePath?: string;
    ide_file_path?: string;
    ideEventType?: string;
    ide_event_type?: string;
    [key: string]: unknown;
}

export interface CompressionMetrics {
    originalTokens: number;
    compressedTokens: number;
    ratio: number;
    saved: number;
    pct: number;
    latency: number;
    algorithm: string;
    timestamp: number;
}

export interface CompressionResult {
    // Engine fields
    og?: string;
    comp?: string;
    metrics?: CompressionMetrics;
    hash?: string;

    // DB fields (Optional for engine return)
    originalSize?: number;
    compressedSize?: number;
    ratio?: number;
    method?: string;
    memoryId?: string;
}

export interface CompressionStats {
    total: number;
    originalTokens: number;
    compressedTokens: number;
    saved: number;
    avgRatio: number;
    latency: number;
    algorithms: Record<string, number>;
    updated: number;

    // Legacy/DB fields mapping (optional depending on usage)
    totalOriginal?: number;
    totalCompressed?: number;
    savedBytes?: number;
    compressedCount?: number;
}

export interface UserMemoriesResult {
    userId: string | null;
    count: number;
    memories: MemoryItem[];
}

export interface MultiVecFusionWeights {
    semanticDimensionWeight: number;
    emotionalDimensionWeight: number;
    proceduralDimensionWeight: number;
    temporalDimensionWeight: number;
    reflectiveDimensionWeight: number;
}

import type { TemporalComparisonResult, VolatileFactsResult } from "./temporal";

export interface TemporalAccess {
    add(subject: string, predicate: string, object: string, opts?: { validFrom?: Date; confidence?: number; metadata?: Record<string, unknown> }): Promise<string>;
    get(subject: string, predicate: string): Promise<any | null>;
    search(pattern: string, opts?: { type?: "subject" | "predicate" | "object" | "all"; at?: Date; limit?: number }): Promise<any[]>;
    updateFact(id: string, confidence?: number, metadata?: Record<string, unknown>): Promise<boolean>;
    invalidateFact(id: string, validTo?: Date): Promise<boolean>;
    queryFacts(subject?: string, predicate?: string, object?: string, at?: Date, minConfidence?: number): Promise<any[]>;
    updateEdge(id: string, weight?: number, metadata?: Record<string, unknown>): Promise<boolean>;
    getFactsBySubject(subject: string, at?: Date, includeHistorical?: boolean, limit?: number): Promise<any[]>;
    getPredicateHistory(predicate: string, from?: Date, to?: Date): Promise<any[]>;
    timeline(subject: string, predicate?: string, includeHistorical?: boolean): Promise<any[]>;
    history(subject: string, predicate?: string, includeHistorical?: boolean): Promise<any[]>;
    addEdge(sourceId: string, targetId: string, relationType: string, opts?: { validFrom?: Date; weight?: number; metadata?: Record<string, unknown> }): Promise<string>;
    getEdges(sourceId?: string, targetId?: string, relationType?: string, at?: Date, limit?: number, offset?: number): Promise<any[]>;
    invalidateEdge(id: string, validTo?: Date): Promise<boolean>;
    compare(subject: string, t1: Date, t2: Date): Promise<TemporalComparisonResult>;
    stats(): Promise<{ facts: { total: number; active: number }; edges: { total: number; active: number } }>;
    decay(decayRate?: number): Promise<number>;
    getGraphContext(factId: string, opts?: { relationType?: string; at?: Date }): Promise<any[]>;
    volatile(subject?: string, limit?: number): Promise<VolatileFactsResult>;
}
