/**
 * @file Temporal Knowledge Graph types.
 */

/**
 * Fact in the Temporal Knowledge Graph.
 */
export interface TemporalFact {
    id: string;
    userId?: string | null;
    subject: string;
    predicate: string;
    object: string;
    /** Start of fact validity (milliseconds) */
    validFrom: number;
    /** End of fact validity or NULL if still valid (milliseconds) */
    validTo: number | null;
    confidence: number;
    /** Source memory ID if derived */
    sourceId?: string;
    /** Timestamp of last modification */
    lastUpdated: number;
    metadata?: Record<string, unknown>;
}

export interface TemporalFactRow {
    id: string;
    userId: string | null;
    subject: string;
    predicate: string;
    object: string;
    validFrom: number;
    validTo: number | null;
    confidence: number;
    lastUpdated: number;
    metadata: Record<string, unknown> | string | null;
}

/**
 * Edge between two temporal facts.
 */
export interface TemporalEdge {
    id: string;
    userId?: string | null;
    sourceId: string;
    targetId: string;
    relationType: string;
    validFrom: number;
    validTo: number | null;
    weight: number;
    lastUpdated: number;
    metadata?: Record<string, unknown>;
}

export interface TemporalEdgeRow {
    id: string;
    userId: string | null;
    sourceId: string;
    targetId: string;
    relationType: string;
    validFrom: number;
    validTo: number | null;
    weight: number;
    lastUpdated: number;
    metadata: Record<string, unknown> | string | null;
}

/**
 * Timeline event showing fact state changes.
 */
export interface TimelineEntry {
    timestamp: number;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    changeType: "created" | "updated" | "invalidated";
}

export type TimelineItem = TimelineEntry;

/**
 * Query parameters for temporal retrieval.
 */
export interface TemporalQuery {
    userId?: string | null;
    subject?: string;
    predicate?: string;
    object?: string;
    at?: number | Date;
    from?: number | Date;
    to?: number | Date;
    minConfidence?: number;
}

/**
 * Result of comparing facts between two timepoints.
 */
export interface TemporalComparisonResult {
    subject: string;
    time1: string;
    time2: string;
    added: TemporalFact[];
    removed: TemporalFact[];
    changed: {
        predicate: string;
        old: TemporalFact;
        new: TemporalFact;
    }[];
    unchanged: TemporalFact[];
    summary: {
        added: number;
        removed: number;
        changed: number;
        unchanged: number;
    };
}

export interface TemporalStatsResult {
    activeFacts: number;
    historicalFacts: number;
    totalFacts: number;
    historicalPercentage: string;
}

export interface VolatileFactsResult {
    subject?: string;
    limit: number;
    volatileFacts: {
        subject: string;
        predicate: string;
        changeCount: number;
        avgConfidence: number;
    }[];
    count: number;
}
