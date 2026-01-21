/**
 * @file Basic Shared Types and Primitives.
 */

export type SectorType =
    | "episodic"
    | "semantic"
    | "procedural"
    | "emotional"
    | "reflective";

export type RpcErrorCode =
    | -32700 // Parse error
    | -32600 // Invalid Request
    | -32601 // Method not found
    | -32602 // Invalid params
    | -32603; // Internal error

/**
 * Result of content classification.
 */
export interface SectorClassification {
    primary: string;
    additional: string[];
    confidence: number;
}

/**
 * Statistics for a cognitive sector.
 */
export interface SectorStat {
    sector: string;
    count: number;
    avgSalience: number;
}

/**
 * Configuration for a cognitive sector.
 */
export interface SectorConfig {
    model: string;
    decayLambda: number;
    weight: number;
    patterns: (string | RegExp)[];
}
