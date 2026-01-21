/**
 * @file Cognitive Dynamics and Associative Memory types.
 */

// Import specifically from relative domain to avoid index barrel
import type { MemoryItem } from "./memory";

/**
 * Configuration constants for the Dynamics module.
 */
export interface DynamicsConstants {
    decay: {
        lambda: number;
        halflife: number;
        minSalience: number;
    };
    weights: {
        recency: number;
        frequency: number;
        emotional: number;
    };
    thresholds: {
        retrieval: number;
        consolidation: number;
    };
}

/**
 * Result of a salience calculation.
 */
export interface SalienceResult {
    success: boolean;
    calculatedSalience: number;
    parameters: Record<string, unknown>;
}

/**
 * Result of a resonance calculation.
 */
export interface ResonanceResult {
    success: boolean;
    resonanceModulatedScore: number;
    parameters: Record<string, unknown>;
}

/**
 * Result of energy-based memory retrieval.
 */
export interface RetrievalResult {
    success: boolean;
    query: string;
    sector: string;
    minEnergy: number;
    count: number;
    memories: {
        id: string;
        content: string;
        primarySector: string;
        salience: number;
        activationEnergy: number;
    }[];
}

/**
 * Result of a reinforcement operation.
 */
export interface ReinforcementResult {
    success: boolean;
    propagatedCount: number;
    newSalience: number;
}

/**
 * Result of a spreading activation simulation.
 */
export interface SpreadingActivationResult {
    success: boolean;
    initialCount: number;
    iterations: number;
    totalActivated: number;
    results: {
        memoryId: string;
        activationLevel: number;
    }[];
}

/**
 * Waypoint in the associative memory graph.
 */
export interface Waypoint {
    srcId: string;
    dstId: string;
    userId: string | null;
    weight: number;
    createdAt: number;
    updatedAt: number;
}

export interface BatchWaypointInsertItem {
    srcId: string;
    dstId: string;
    userId: string | null | undefined;
    weight: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * Associative Waypoint Graph structure.
 */
export interface WaypointGraphResult {
    success: boolean;
    stats: {
        totalNodes: number;
        totalEdges: number;
        averageEdgesPerNode: number;
        disconnectedNodes: number;
    };
    nodes: {
        memoryId: string;
        edgeCount: number;
        connections: {
            targetId: string;
            weight: number;
            timeGapMs: number;
        }[];
    }[];
}

/**
 * Result of a waypoint weight calculation.
 */
export interface WaypointWeightResult {
    success: boolean;
    sourceId: string;
    targetId: string;
    weight: number;
    timeGapDays: number;
    details: {
        temporalDecay: boolean;
        cosineSimilarity: boolean;
    };
}

/**
 * Result of a HSG (Hyper Semantic Graph) query.
 */
export interface HsgQueryResult extends MemoryItem {
    score: number;
    path: string[];
}
