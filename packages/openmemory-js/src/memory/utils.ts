/**
 * @file Memory utilities for consistent hydration and processing.
 */
import { env } from "../core/cfg";
import { sectorConfigs, hybridParams, scoringWeights } from "../core/hsgConfig";
import { MemoryRow, MemoryItem, EmbeddingResult, SectorClassification } from "../core/types";
import { normalizeUserId, parseJSON } from "../utils";
import { logger } from "../utils/logger";
import { canonicalTokenSet } from "../utils/text";
import { aggregateVectorsOptimized, VectorOperationStats } from "../utils/vectorsOptimized";

/**
 * Hydrates a raw DB MemoryRow into a usable MemoryItem.
 * Handles parsing of JSON fields (tags, metadata) safely.
 * 
 * @param row The raw database row.
 * @param metadata Optional pre-parsed or auxiliary metadata to merge/override.
 * @param tags Optional pre-parsed tags to override.
 * @returns A fully hydrated MemoryItem.
 */
export function hydrateMemoryRow(
    row: MemoryRow,
    metadata?: Record<string, unknown> | null,
    tags?: string[] | null
): MemoryItem {
    const parsedTags = tags || (row.tags ? (Array.isArray(row.tags) ? row.tags : parseJSON<string[]>(row.tags)) : []) || [];
    const parsedMeta = metadata || (row.metadata ? (typeof row.metadata === 'object' ? row.metadata : parseJSON<Record<string, unknown>>(row.metadata)) : {}) || {};

    return {
        id: row.id,
        content: row.content || "",
        primarySector: row.primarySector,
        tags: parsedTags,
        metadata: parsedMeta,
        createdAt: row.createdAt || 0,
        updatedAt: row.updatedAt || 0,
        lastSeenAt: row.lastSeenAt || 0,
        salience: row.salience || 0.5,
        decayLambda: row.decayLambda || 0.005,
        version: row.version || 1,
        userId: row.userId || null,
        segment: row.segment || 0,
        simhash: row.simhash || null,
        generatedSummary: row.generatedSummary || null,
        // Optional fields that might be populated later
        sectors: [row.primarySector],
        compressedVecStr: undefined // Populated by API layer if needed
    };
}

/**
 * Resolves current sector weights, applying environment variable overrides.
 */
export function getSectorWeights(): Record<string, number> {
    const weights: Record<string, number> = {};

    // Default from sectorConfigs
    for (const [s, c] of Object.entries(sectorConfigs)) {
        weights[s] = c.weight;
    }

    // Apply overrides from env
    const overrides = (env.sectorWeights || {}) as Record<string, unknown>;
    for (const [s, w] of Object.entries(overrides)) {
        const val = Number(w);
        if (!isNaN(val)) {
            weights[s] = val;
        }
    }
    return weights;
}

/**
 * Calculates a hybrid score across multiple cognitive signals.
 */
export function computeHybridScore(
    sim: number,
    tokOv: number,
    wpWt: number,
    recSc: number,
    keywordScore: number = 0,
    tagMatch: number = 0,
    salience: number = 0,
): number {
    // Normalize each component to [0, 1]
    const normalizedSim = Math.max(0, Math.min(1, sim));
    const normalizedOverlap = Math.max(0, Math.min(1, tokOv));
    const normalizedRecency = Math.max(0, Math.min(1, recSc));
    const normalizedTag = Math.max(0, Math.min(1, tagMatch));
    const normalizedSalience = Math.max(0, Math.min(1, salience));

    const score =
        normalizedSim * scoringWeights.similarity +
        normalizedOverlap * scoringWeights.overlap +
        wpWt * scoringWeights.waypoint +
        normalizedRecency * scoringWeights.recency +
        normalizedTag * scoringWeights.tagMatch +
        normalizedSalience * scoringWeights.salience +
        keywordScore * scoringWeights.keyword;

    return Math.max(0, Math.min(1, score));
}

/**
 * Computes token overlap between two sets (relative to query size).
 */
export function computeTokenOverlap(
    qToks: Set<string>,
    memToks: Set<string>,
): number {
    if (qToks.size === 0) return 0;
    let ov = 0;
    for (const t of qToks) if (memToks.has(t)) ov++;
    return ov / qToks.size;
}

/**
 * Calculates the weighted mean vector for a set of multi-sector embeddings.
 * Uses optimized vector operations with selective SIMD-like processing for better performance.
 */
export function calcMeanVec(
    embRes: EmbeddingResult[],
): number[] {
    if (embRes.length === 0) return [];
    
    const stats = VectorOperationStats.getInstance();
    const startTime = performance.now();
    
    const dim = embRes[0].vector.length;
    const secWeights = getSectorWeights();
    const beta = hybridParams.beta;
    
    // Pre-calculate exponential weights for better performance
    const expWeights: number[] = [];
    let expSum = 0;
    
    for (const result of embRes) {
        const expWeight = Math.exp(beta * (secWeights[result.sector] || 1.0));
        expWeights.push(expWeight);
        expSum += expWeight;
    }
    
    // Use optimized aggregation with pre-computed weights
    const weightedVectors: number[][] = [];
    
    for (let i = 0; i < embRes.length; i++) {
        const result = embRes[i];
        const smWt = expWeights[i] / expSum;
        
        // Create weighted vector - use simple approach for small vectors, optimized for large
        const weightedVec = new Array(dim);
        const sourceVec = result.vector;
        
        if (dim >= 1000) {
            // SIMD-like processing for large vectors only
            let j = 0;
            const chunks = Math.floor(dim / 8);
            
            // Process 8 elements at a time for better CPU cache utilization
            for (let chunk = 0; chunk < chunks; chunk++) {
                const base = chunk * 8;
                weightedVec[base] = sourceVec[base] * smWt;
                weightedVec[base + 1] = sourceVec[base + 1] * smWt;
                weightedVec[base + 2] = sourceVec[base + 2] * smWt;
                weightedVec[base + 3] = sourceVec[base + 3] * smWt;
                weightedVec[base + 4] = sourceVec[base + 4] * smWt;
                weightedVec[base + 5] = sourceVec[base + 5] * smWt;
                weightedVec[base + 6] = sourceVec[base + 6] * smWt;
                weightedVec[base + 7] = sourceVec[base + 7] * smWt;
            }
            
            // Handle remaining elements
            for (j = chunks * 8; j < dim; j++) {
                weightedVec[j] = sourceVec[j] * smWt;
            }
        } else {
            // Simple approach for smaller vectors
            for (let j = 0; j < dim; j++) {
                weightedVec[j] = sourceVec[j] * smWt;
            }
        }
        
        weightedVectors.push(weightedVec);
    }
    
    // Use optimized aggregation
    const aggregated = aggregateVectorsOptimized(weightedVectors);
    
    // Optimized normalization with selective SIMD processing
    let normSquared = 0;
    
    if (dim >= 1000) {
        const chunks = Math.floor(dim / 8);
        
        // Calculate norm using chunked processing for large vectors
        for (let chunk = 0; chunk < chunks; chunk++) {
            const base = chunk * 8;
            let chunkSum = 0;
            chunkSum += aggregated[base] * aggregated[base];
            chunkSum += aggregated[base + 1] * aggregated[base + 1];
            chunkSum += aggregated[base + 2] * aggregated[base + 2];
            chunkSum += aggregated[base + 3] * aggregated[base + 3];
            chunkSum += aggregated[base + 4] * aggregated[base + 4];
            chunkSum += aggregated[base + 5] * aggregated[base + 5];
            chunkSum += aggregated[base + 6] * aggregated[base + 6];
            chunkSum += aggregated[base + 7] * aggregated[base + 7];
            normSquared += chunkSum;
        }
        
        // Handle remaining elements
        for (let i = chunks * 8; i < dim; i++) {
            normSquared += aggregated[i] * aggregated[i];
        }
    } else {
        // Simple approach for smaller vectors
        for (let i = 0; i < dim; i++) {
            normSquared += aggregated[i] * aggregated[i];
        }
    }
    
    const norm = Math.sqrt(normSquared) + hybridParams.epsilon;
    const invNorm = 1 / norm;
    
    // Optimized normalization with selective chunking
    const result = new Array(dim);
    if (dim >= 1000) {
        const chunks = Math.floor(dim / 8);
        for (let chunk = 0; chunk < chunks; chunk++) {
            const base = chunk * 8;
            result[base] = aggregated[base] * invNorm;
            result[base + 1] = aggregated[base + 1] * invNorm;
            result[base + 2] = aggregated[base + 2] * invNorm;
            result[base + 3] = aggregated[base + 3] * invNorm;
            result[base + 4] = aggregated[base + 4] * invNorm;
            result[base + 5] = aggregated[base + 5] * invNorm;
            result[base + 6] = aggregated[base + 6] * invNorm;
            result[base + 7] = aggregated[base + 7] * invNorm;
        }
        
        for (let i = chunks * 8; i < dim; i++) {
            result[i] = aggregated[i] * invNorm;
        }
    } else {
        for (let i = 0; i < dim; i++) {
            result[i] = aggregated[i] * invNorm;
        }
    }
    
    stats.recordAggregation(performance.now() - startTime);
    return result;
}

/**
 * Calculates a score based on matching query tokens with memory tags.
 */
export async function computeTagMatchScore(
    mem: MemoryRow,
    queryTokens: Set<string>,
): Promise<number> {
    if (!mem || !mem.tags) return 0;
    try {
        let tags: string[] = [];
        if (typeof mem.tags === "string") {
            try {
                tags = JSON.parse(mem.tags);
            } catch {
                tags = [];
            }
        } else if (Array.isArray(mem.tags)) {
            tags = mem.tags;
        }
        if (!tags || !Array.isArray(tags)) return 0;

        let matches = 0;
        for (const tag of tags) {
            const tagLower = String(tag).toLowerCase();
            if (queryTokens.has(tagLower)) {
                matches += 2;
            } else {
                for (const token of queryTokens) {
                    if (tagLower.includes(token) || token.includes(tagLower)) {
                        matches += 1;
                    }
                }
            }
        }
        return Math.min(1.0, matches / Math.max(1, tags.length * 2));
    } catch (err) {
        logger.debug(`[HSG] Tag match calculation failed for ${mem.id}:`, {
            error: err,
        });
        return 0;
    }
}

const sectors = Object.keys(sectorConfigs);

/**
 * Classifies content into one or more cognitive sectors based on patterns and metadata.
 */
export function classifyContent(
    content: string,
    metadata?: Record<string, unknown>,
): SectorClassification {
    if (
        metadata &&
        typeof metadata.sector === "string" &&
        sectors.includes(metadata.sector)
    ) {
        return { primary: metadata.sector, additional: [], confidence: 1.0 };
    }
    const matches: Array<{ sector: string; score: number }> = [];
    const secWeights = getSectorWeights();

    for (const [sector, config] of Object.entries(sectorConfigs)) {
        let score = 0;
        for (const pattern of config.patterns) {
            // Handle Regex or String patterns safely
            const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'gi');
            const matchCount = (content.match(regex) || []).length;
            score += matchCount * (secWeights[sector] || config.weight);
        }
        if (score > 0) matches.push({ sector, score });
    }

    if (matches.length === 0) {
        return { primary: "semantic", additional: [], confidence: 0.2 };
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    const primary = matches[0].sector;
    const primaryScore = matches[0].score;
    // Keep logic for confidence/threshold
    const threshold = Math.max(1, primaryScore * 0.3);
    const additional = matches
        .slice(1)
        .filter((m) => m.score >= threshold)
        .map((m) => m.sector);

    const confidence =
        primaryScore > 0
            ? Math.min(
                1.0,
                primaryScore /
                (primaryScore + (matches[1]?.score || 0) + 1),
            )
            : 0.2;

    return {
        primary,
        additional,
        confidence,
    };
}
