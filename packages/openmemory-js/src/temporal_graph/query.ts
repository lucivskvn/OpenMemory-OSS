/**
 * Temporal Knowledge Graph Query Engine for OpenMemory.
 * Provides APIs for point-in-time retrieval, range queries, and relationship traversal.
 */
import { env } from "../core/cfg";
import { q } from "../core/db";
import { getEncryption } from "../core/security";
import { normalizeUserId } from "../utils";
import { SimpleCache } from "../utils/cache";
import {
    TemporalEdge,
    TemporalEdgeRow,
    TemporalFact,
    TemporalFactRow,
} from "./types";

// Caches to avoid redundant decryption/parsing
export const factCache = new SimpleCache<string, TemporalFact>({
    maxSize: env.graphCacheSize,
    ttlMs: 1800000,
}); // 30 min
export const edgeCache = new SimpleCache<string, TemporalEdge>({
    maxSize: env.graphCacheSize * 2,
    ttlMs: 1800000,
});

/**
 * Converts a database row to a TemporalFact object.
 * Handles decryption of metadata and caching.
 * @param row The raw database row.
 * @returns The hydrated TemporalFact object.
 */
export async function rowToFact(
    row: TemporalFactRow | null,
): Promise<TemporalFact> {
    if (!row) return null as unknown as TemporalFact;

    // Cache key includes ID and last_updated to handle updates
    const cacheKey = `${row.id}:${row.lastUpdated}`;
    const cached = factCache.get(cacheKey);
    if (cached) return cached;

    const enc = getEncryption();
    let meta: Record<string, unknown> = {};
    if (row.metadata) {
        // Optimization: Check if it's already an object (Bun SQLite driver might parse JSON columns automatically)
        if (typeof row.metadata === 'object' && row.metadata !== null) {
            meta = row.metadata as Record<string, unknown>;
        } else if (typeof row.metadata === 'string') {
            try {
                // Priority 1: Decrypt if it looks encrypted (starts with "enc:")
                // Or just try decrypting.
                const asStr = row.metadata as string;
                if (asStr.startsWith('{"iv":')) {
                    const dec = await enc.decrypt(asStr);
                    meta = JSON.parse(dec);
                } else {
                    meta = JSON.parse(asStr);
                }
            } catch {
                // Fallback
                meta = { _raw: row.metadata };
            }
        }
    }
    const fact: TemporalFact = {
        id: row.id,
        userId: row.userId,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        validFrom: row.validFrom,
        validTo: row.validTo,
        confidence: row.confidence,
        lastUpdated: row.lastUpdated,
        metadata: meta,
    };

    factCache.set(cacheKey, fact);
    return fact;
}

/**
 * Converts a database row to a TemporalEdge object.
 * Handles decryption of metadata and caching.
 * @param row The raw database row.
 * @returns The hydrated TemporalEdge object.
 */
export async function rowToEdge(
    row: TemporalEdgeRow | null,
): Promise<TemporalEdge> {
    if (!row) return null as unknown as TemporalEdge;

    const cacheKey = `${row.id}:${row.lastUpdated}`;
    const cached = edgeCache.get(cacheKey);
    if (cached) return cached;

    const enc = getEncryption();
    let meta: Record<string, unknown> = {};
    if (row.metadata) {
        try {
            const dec = await enc.decrypt(row.metadata);
            meta = JSON.parse(dec);
        } catch {
            try {
                meta =
                    typeof row.metadata === "string"
                        ? JSON.parse(row.metadata)
                        : row.metadata;
            } catch {
                meta = { _raw: row.metadata };
            }
        }
    }
    const edge: TemporalEdge = {
        id: row.id,
        userId: row.userId,
        sourceId: row.sourceId,
        targetId: row.targetId,
        relationType: row.relationType,
        validFrom: row.validFrom,
        validTo: row.validTo,
        weight: row.weight,
        lastUpdated: row.lastUpdated,
        metadata: meta,
    };

    edgeCache.set(cacheKey, edge);
    return edge;
}

/**
 * Query facts valid at a specific point in time.
 * @param subject Optional subject filter
 * @param predicate Optional predicate filter
 * @param object Optional object filter
 * @param at Point in time to query (defaults to now)
 * @param minConfidence Minimum confidence threshold (default 0.0)
 * @param userId Owner of the facts (if null, checks for global facts; if undefined, checks all)
 * @returns Array of matching TemporalFact objects
 */
export const queryFactsAtTime = async (
    subject?: string,
    predicate?: string,
    object?: string,
    at: Date = new Date(),
    minConfidence: number = 0.0,
    userId?: string | null,
): Promise<TemporalFact[]> => {
    const timestamp = at.getTime();
    const uid = normalizeUserId(userId);

    const rows = await q.queryFactsAtTime.all(timestamp, subject, predicate, object, minConfidence, uid) as TemporalFactRow[];
    return Promise.all(rows.map(rowToFact));
};

/**
 * Get the single most current fact matching the criteria.
 * @param subject Exact subject
 * @param predicate Exact predicate
 * @param userId Owner ID
 * @param at Point in time (optional)
 * @returns The matching Fact or null
 */
export const getCurrentFact = async (
    subject: string,
    predicate: string,
    userId?: string | null,
    at?: Date,
): Promise<TemporalFact | null> => {
    const uid = normalizeUserId(userId);
    const timestamp = at?.getTime();

    const row = await q.getCurrentFact.get(subject, predicate, timestamp, uid) as TemporalFactRow | undefined;
    return await rowToFact(row || null);
};

/**
 * Query facts that were valid at any point within a time range.
 * @param subject Subject filter
 * @param predicate Predicate filter
 * @param object Object filter
 * @param from Start of range
 * @param to End of range
 * @param minConfidence Minimum confidence
 * @param userId User ID
 * @param limit Max results
 */
export const queryFactsInRange = async (
    subject?: string,
    predicate?: string,
    object?: string,
    from?: Date,
    to?: Date,
    minConfidence: number = 0.1,
    userId?: string | null,
    limit: number = 500,
): Promise<TemporalFact[]> => {
    const uid = normalizeUserId(userId);
    const fromTs = from?.getTime();
    const toTs = to?.getTime();

    const rows = await q.queryFactsInRange.all(fromTs, toTs, subject, predicate, object, minConfidence, limit, uid) as TemporalFactRow[];
    return Promise.all(rows.map(rowToFact));
};

/**
 * Find conflicting facts (same subject/predicate) valid at the same time.
 * Useful for consistency checks.
 * @param subject Subject
 * @param predicate Predicate
 * @param at Time to check
 * @param userId User ID
 */
export const findConflictingFacts = async (
    subject: string,
    predicate: string,
    at: Date = new Date(),
    userId?: string | null,
): Promise<TemporalFact[]> => {
    const timestamp = at ? at.getTime() : Date.now();
    const uid = normalizeUserId(userId);

    const rows = await q.findConflictingFacts.all(subject, predicate, timestamp, uid) as TemporalFactRow[];
    return Promise.all(rows.map(rowToFact));
};

/**
 * Get all facts known about a subject.
 * @param subject The entity subject
 * @param at Time (if not historical)
 * @param includeHistorical If true, returns all history regardless of validity
 * @param userId User ID
 * @param limit Limit results
 */
export const getFactsBySubject = async (
    subject: string,
    at: Date = new Date(),
    includeHistorical: boolean = false,
    userId?: string | null,
    limit: number = 500,
): Promise<TemporalFact[]> => {
    const uid = normalizeUserId(userId);
    const timestamp = at ? at.getTime() : Date.now();

    const rows = await q.getFactsBySubject.all(subject, timestamp, includeHistorical, limit, uid) as TemporalFactRow[];
    return Promise.all(rows.map(rowToFact));
};

/**
 * Search facts using SQL LIKE matching.
 * @param pattern The search pattern (do not include wildcards, they are added automatically)
 * @param type Search scope: "subject", "predicate", "object", or "all"
 * @param at Time constraint
 * @param limit Max results
 * @param userId User ID
 */
export const searchFacts = async (
    pattern: string,
    type: "subject" | "predicate" | "object" | "all" = "all",
    at?: Date,
    limit: number = 10,
    userId?: string | null,
): Promise<TemporalFact[]> => {
    const timestamp = at?.getTime();
    const uid = normalizeUserId(userId);

    const rows = await q.searchFacts.all(pattern, type, timestamp, limit, uid) as TemporalFactRow[];
    return Promise.all(rows.map(rowToFact));
};

/**
 * Get facts directly connected to a specific fact via Edges.
 * Represents a 1-hop neighborhood in the knowledge graph.
 * @param factId The source fact ID
 * @param relationType Optional edge type filter
 * @param at Time constraint
 * @param userId User ID
 */
export const getRelatedFacts = async (
    factId: string,
    relationType?: string,
    at?: Date,
    userId?: string,
): Promise<Array<{ fact: TemporalFact; relation: string; weight: number }>> => {
    const timestamp = at ? at.getTime() : Date.now();
    const uid = normalizeUserId(userId);

    // Repo returns row plus relation_type and weight
    const rows = await q.getRelatedFacts.all(factId, relationType, timestamp, uid) as (TemporalFactRow & { relation_type: string; weight: number })[];

    return Promise.all(
        rows.map(async (row) => ({
            fact: await rowToFact(row),
            relation: row.relation_type,
            weight: row.weight,
        })),
    );
};

/**
 * Query edges (relationships between facts) with filters.
 * @param sourceId Filter by source fact ID
 * @param targetId Filter by target fact ID
 * @param relationType Filter by relationship type
 * @param at Time constraint
 * @param userId User ID
 * @param limit Limit
 * @param offset Offset
 */
export const queryEdges = async (
    sourceId?: string,
    targetId?: string,
    relationType?: string,
    at?: Date,
    userId?: string | null,
    limit: number = 100,
    offset: number = 0,
): Promise<TemporalEdge[]> => {
    const timestamp = at ? at.getTime() : Date.now();
    const uid = normalizeUserId(userId);

    const rows = await q.queryEdges.all(sourceId, targetId, relationType, timestamp, limit, offset, uid) as TemporalEdgeRow[];
    return Promise.all(rows.map(rowToEdge));
};

/**
 * Get all facts that were valid during the specified window.
 * @param startTime Start of window
 * @param endTime End of window
 * @param userId User ID
 */
export const getFactsInRange = async (
    startTime: Date,
    endTime: Date,
    userId?: string | null,
): Promise<TemporalFact[]> => {
    // Reusing queryFactsInRange which supports range
    return await queryFactsInRange(undefined, undefined, undefined, startTime, endTime, 0, userId, 10000);
};
