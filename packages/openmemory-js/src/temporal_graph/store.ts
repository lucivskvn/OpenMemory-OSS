/**
 * @file store.ts
 * @description Temporal Knowledge Graph Store for OpenMemory.
 * @audited 2026-01-19
 */


import { env } from "../core/cfg";
import {
    q,
    runUser,
    transaction,
    TABLES
} from "../core/db";
import { eventBus, EVENTS } from "../core/events";
import { getEncryption } from "../core/security";
import { normalizeUserId } from "../utils";
import { logger } from "../utils/logger";
import { TemporalEdgeRow, TemporalFactRow } from "./types";

/**
 * Inserts a new temporal fact.
 * Handles collision detection and resolution:
 * - If an EXACT active fact exists, updates confidence/metadata.
 * - If overlapping facts exist, "closes" them (sets valid_to) to maintain temporal history.
 * - @warning **Cardinality 1**: This implementation enforces Single-Value Predicates. Inserting `(S, P, O2)` IMPLICITLY invalidates `(S, P, O1)`.
 * - Ensures no contradictory duplicate facts exist at the same time.
 * @param subject - The subject entity.
 * @param predicate - The relationship predicate.
 * @param object - The object entity.
 * @param validFrom - Start of validity (default: now).
 * @param confidence - Certainty (0.0-1.0).
 * @param metadata - Optional JSON metadata.
 * @param userId - Owner context.
 * @returns UUID of the inserted (or updated) fact.
 */
const validateInput = (
    ...args: [string, any][]
) => {
    for (const [key, val] of args) {
        if (val === undefined || val === null || (typeof val === 'string' && val.trim().length === 0)) {
            throw new Error(`[TEMPORAL] Invalid Input: ${key} cannot be empty.`);
        }
    }
};

/**
 * Inserts a new temporal fact.
 * Handles collision detection and resolution:
 * - If an EXACT active fact exists, updates confidence/metadata.
 * - If overlapping facts exist, "closes" them (sets valid_to) to maintain temporal history.
 * - @warning **Cardinality 1**: This implementation enforces Single-Value Predicates. Inserting `(S, P, O2)` IMPLICITLY invalidates `(S, P, O1)`.
 * - Ensures no contradictory duplicate facts exist at the same time.
 * @param subject - The subject entity.
 * @param predicate - The relationship predicate.
 * @param object - The object entity.
 * @param validFrom - Start of validity (default: now).
 * @param confidence - Certainty (0.0-1.0).
 * @param metadata - Optional JSON metadata.
 * @param userId - Owner context.
 * @returns UUID of the inserted (or updated) fact.
 */
export const insertFact = async (
    subject: string,
    predicate: string,
    object: string,
    validFrom: Date = new Date(),
    confidence: number = 1.0,
    metadata?: Record<string, unknown>,
    userId?: string | null,
): Promise<string> => {
    validateInput(
        ["subject", subject],
        ["predicate", predicate],
        ["object", object]
    );

    const id = crypto.randomUUID();
    const now = Date.now();
    const validFromTs = validFrom.getTime();
    const uid = normalizeUserId(userId);

    return await transaction.run(async () => {
        const match = await q.findActiveFact.get(subject, predicate, object, uid) as TemporalFactRow | undefined;

        if (match) {
            if (env.verbose) logger.debug(`[TEMPORAL] Existing active fact found for ${subject} ${predicate} ${object}. Updating.`);
            const newConfidence = Math.max(match.confidence, confidence);
            const metaStr = metadata ? JSON.stringify(metadata) : null;
            const encryptedMeta = metaStr ? await getEncryption().encrypt(metaStr) : null;

            await q.updateFactConfidence.run(
                match.id,
                newConfidence,
                encryptedMeta,
                now
            );
            eventBus.emit(EVENTS.TEMPORAL_FACT_UPDATED, {
                id: match.id,
                userId: uid ?? undefined,
                confidence: newConfidence,
                metadata,
            });
            return match.id;
        }

        const existing = await q.getOverlappingFacts.all(subject, predicate, validFromTs, uid) as TemporalFactRow[];
        let newFactValidTo: number | null = null;

        for (const old of existing) {
            const oldValidFrom = Number(old.validFrom);
            if (oldValidFrom < validFromTs) {
                await q.closeFact.run(old.id, validFromTs - 1);
                if (env.verbose) logger.debug(`[TEMPORAL] Closed fact ${old.id}`);
            } else if (oldValidFrom === validFromTs) {
                await q.closeFact.run(old.id, validFromTs - 1);
                if (env.verbose) logger.debug(`[TEMPORAL] Collided fact ${old.id} invalidated`);
            } else if (oldValidFrom > validFromTs) {
                if (newFactValidTo === null || oldValidFrom - 1 < newFactValidTo) {
                    newFactValidTo = oldValidFrom - 1;
                }
            }
        }

        const metaStr = metadata ? JSON.stringify(metadata) : null;
        const encryptedMeta = metaStr ? await getEncryption().encrypt(metaStr) : null;

        await q.insertFactRaw.run({
            id,
            userId: uid ?? null,
            subject,
            predicate,
            object,
            validFrom: validFromTs,
            validTo: newFactValidTo,
            confidence,
            lastUpdated: now,
            metadata: encryptedMeta
        });

        if (env.verbose) logger.debug(`[TEMPORAL] Inserted fact: ${subject} ${predicate} ${object}`);

        eventBus.emit(EVENTS.TEMPORAL_FACT_CREATED, {
            id,
            userId: uid ?? undefined,
            subject,
            predicate,
            object,
            validFrom: validFromTs,
            validTo: newFactValidTo,
            confidence,
            metadata,
        });
        return id;
    });
};

export const updateFact = async (
    id: string,
    userId?: string | null,
    confidence?: number,
    metadata?: Record<string, unknown>,
): Promise<void> => {
    const changes = await transaction.run(async () => {
        const updates: string[] = [];
        const params: (string | number | null)[] = [];
        const uid = normalizeUserId(userId);

        if (confidence !== undefined) {
            updates.push("confidence = ?");
            params.push(confidence);
        }
        if (metadata !== undefined) {
            updates.push("metadata = ?");
            params.push(await getEncryption().encrypt(JSON.stringify(metadata)));
        }
        updates.push("last_updated = ?");
        params.push(Date.now());

        if (updates.length > 0) {
            const result = await q.updateFactRaw.run(id, updates, params, uid);
            if (result === 0) {
                logger.error(`[TEMPORAL] Update failed: Fact ${id} not found for user ${uid}`);
            }
            return result;
        }
        return 0;
    });

    if (changes > 0) {
        if (env.verbose) logger.debug(`[TEMPORAL] Updated fact ${id}`);
        eventBus.emit(EVENTS.TEMPORAL_FACT_UPDATED, {
            id,
            userId: normalizeUserId(userId) ?? undefined,
            confidence,
            metadata,
        });
    }
};

export const invalidateFact = async (
    id: string,
    userId?: string | null,
    validTo: Date = new Date(),
): Promise<void> => {
    validateInput(["id", id]);
    const uid = normalizeUserId(userId);

    const changes = await transaction.run(async () => {
        const existing = await q.getFact.get(id, uid) as TemporalFactRow | undefined;
        if (!existing) {
            logger.error(`[TEMPORAL] Invalidation failed: Fact ${id} not found for user ${uid}`);
            return 0;
        }

        const validFromTs = Number(existing.validFrom);
        const validToTs = validTo.getTime();

        if (validToTs < validFromTs) {
            throw new Error(`[TEMPORAL] Integrity Error: validTo cannot be before validFrom`);
        }

        const result = await q.updateFactRaw.run(id, ["valid_to = ?", "last_updated = ?"], [validToTs, Date.now()], uid);
        return result;
    });

    if (changes > 0) {
        if (env.verbose) logger.debug(`[TEMPORAL] Invalidated fact ${id}`);
        eventBus.emit(EVENTS.TEMPORAL_FACT_DELETED, {
            id,
            userId: uid ?? undefined,
            validTo: validTo.getTime(),
        });
    }
};

export const deleteFact = async (
    id: string,
    userId?: string | null,
): Promise<void> => {
    validateInput(["id", id]);
    const uid = normalizeUserId(userId);

    await transaction.run(async () => {
        // Hard delete fact using repository method
        const changes = await q.deleteFactCascade.run(id, uid);

        if (changes > 0) {
            // Also delete related edges (orphans) using repository method
            await q.deleteEdgesByNode.run(id, uid);
            if (env.verbose) logger.debug(`[TEMPORAL] Deleted fact ${id} and related edges`);
        }
    });
};

export const insertEdge = async (
    sourceId: string,
    targetId: string,
    relationType: string,
    validFrom: Date = new Date(),
    weight: number = 1.0,
    metadata?: Record<string, unknown>,
    userId?: string | null,
): Promise<string> => {
    validateInput(
        ["sourceId", sourceId],
        ["targetId", targetId],
        ["relationType", relationType]
    );

    const id = crypto.randomUUID();
    const validFromTs = validFrom.getTime();
    const uid = normalizeUserId(userId);

    return await transaction.run(async () => {
        const match = await q.findActiveEdge.get(sourceId, targetId, relationType, uid) as TemporalEdgeRow | undefined;

        if (match) {
            if (env.verbose) logger.debug(`[TEMPORAL] Existing active edge found. Updating.`);
            const now = Date.now();
            const newWeight = Math.max(match.weight || 0, weight);

            const metaStr = metadata ? JSON.stringify(metadata) : null;
            const encryptedMeta = metaStr ? await getEncryption().encrypt(metaStr) : null;

            await q.updateEdgeWeight.run(
                match.id,
                newWeight,
                encryptedMeta,
                now
            );

            eventBus.emit(EVENTS.TEMPORAL_EDGE_UPDATED, {
                id: match.id,
                userId: uid ?? undefined,
                weight: newWeight,
                lastUpdated: now,
                metadata,
            });
            return match.id;
        }

        const existing = await q.getOverlappingEdges.all(sourceId, targetId, relationType, validFromTs, uid) as TemporalEdgeRow[];
        for (const old of existing) {
            if (old.validFrom < validFromTs) {
                await q.closeEdge.run(old.id, validFromTs - 1);
                if (env.verbose) logger.debug(`[TEMPORAL] Closed edge ${old.id}`);
            }
        }

        const now = Date.now();
        const metaStr = metadata ? JSON.stringify(metadata) : null;
        const encryptedMeta = metaStr ? await getEncryption().encrypt(metaStr) : null;

        await q.insertEdgeRaw.run({
            id,
            userId: uid ?? null,
            sourceId,
            targetId,
            relationType,
            validFrom: validFromTs,
            validTo: null,
            weight,
            lastUpdated: now,
            metadata: encryptedMeta
        });

        if (env.verbose) logger.debug(`[TEMPORAL] Created edge: ${sourceId} --[${relationType}]--> ${targetId}`);

        eventBus.emit(EVENTS.TEMPORAL_EDGE_CREATED, {
            id,
            userId: uid ?? undefined,
            sourceId,
            targetId,
            relationType,
            validFrom: validFromTs,
            weight,
            lastUpdated: now,
            metadata,
        });
        return id;
    });
};

export const invalidateEdge = async (
    id: string,
    userId?: string | null,
    validTo: Date = new Date(),
): Promise<void> => {
    validateInput(["id", id]);
    const uid = normalizeUserId(userId);

    const changes = await transaction.run(async () => {
        const existing = await q.getEdge.get(id, uid) as TemporalEdgeRow | undefined;
        if (!existing) {
            logger.error(`[TEMPORAL] Invalidation failed: Edge ${id} not found for user ${uid}`);
            return 0;
        }

        const validFromTs = Number(existing.validFrom);
        const validToTs = validTo.getTime();

        if (validToTs < validFromTs) {
            throw new Error(`[TEMPORAL] Integrity Error: validTo cannot be before validFrom`);
        }

        const result = await q.closeEdge.run(id, validToTs, uid);
        return result;
    });

    if (changes > 0) {
        if (env.verbose) logger.debug(`[TEMPORAL] Invalidated edge ${id}`);
        eventBus.emit(EVENTS.TEMPORAL_EDGE_DELETED, {
            id,
            userId: uid ?? undefined,
            validTo: validTo.getTime(),
        });
    }
};

export const updateEdge = async (
    id: string,
    options: { weight?: number; metadata?: Record<string, unknown> },
    userId?: string | null,
): Promise<void> => {
    const changes = await transaction.run(async () => {
        const updates: string[] = [];
        const params: (string | number | null)[] = [];
        const uid = normalizeUserId(userId);

        if (options.weight !== undefined) {
            updates.push("weight = ?");
            params.push(options.weight);
        }
        if (options.metadata !== undefined) {
            updates.push("metadata = ?");
            params.push(await getEncryption().encrypt(JSON.stringify(options.metadata)));
        }
        updates.push("last_updated = ?");
        params.push(Date.now());

        if (updates.length > 0) {
            const result = await q.updateEdgeRaw.run(id, updates, params, uid);
            if (result === 0) {
                logger.error(`[TEMPORAL] Update edge failed: Edge ${id} not found for user ${uid}`);
            }
            return result;
        }
        return 0;
    });

    if (changes > 0) {
        if (env.verbose) logger.debug(`[TEMPORAL] Updated edge ${id}`);
        eventBus.emit(EVENTS.TEMPORAL_EDGE_UPDATED, {
            id,
            userId: normalizeUserId(userId) ?? undefined,
            weight: options.weight,
            metadata: options.metadata,
            lastUpdated: Date.now(),
        });
    }
};

export const batchInsertFacts = async (
    facts: Array<{
        subject: string;
        predicate: string;
        object: string;
        validFrom?: Date;
        confidence?: number;
        metadata?: Record<string, unknown>;
        userId?: string;
    }>,
    userId?: string,
): Promise<string[]> => {
    if (facts.length === 0) return [];
    const ids: string[] = [];

    return await transaction.run(async () => {
        for (const fact of facts) {
            const id = await insertFact(
                fact.subject,
                fact.predicate,
                fact.object,
                fact.validFrom,
                fact.confidence,
                fact.metadata,
                fact.userId || userId,
            );
            ids.push(id);
        }
        if (env.verbose) logger.info(`[TEMPORAL] Batch inserted ${ids.length} facts`);
        return ids;
    });
};

export const applyConfidenceDecay = async (
    decayRate: number = 0.01,
    userId?: string | null,
): Promise<number> => {
    const now = Date.now();
    const oneDay = 86400000;
    const uid = normalizeUserId(userId);

    // Use repository method providing 'now' and 'oneDay'
    const changes = await q.applyConfidenceDecay.run(decayRate, now, oneDay, uid);

    if (env.verbose) logger.info(`[TEMPORAL] Applied confidence decay to ${changes} facts`);
    return changes;
};

export const getActiveFactsCount = async (
    userId?: string | null,
): Promise<number> => {
    const uid = normalizeUserId(userId);
    const result = await q.getActiveFactCount.get(uid);
    return result?.c || 0;
};

export const getTotalFactsCount = async (
    userId?: string | null,
): Promise<number> => {
    const uid = normalizeUserId(userId);
    const result = await q.getFactCount.get(uid);
    return result?.c || 0;
};

export const getActiveEdgesCount = async (
    userId?: string | null,
): Promise<number> => {
    const uid = normalizeUserId(userId);
    const result = await q.getActiveEdgeCount.get(uid);
    return result?.c || 0;
};

export const getTotalEdgesCount = async (
    userId?: string | null,
): Promise<number> => {
    const uid = normalizeUserId(userId);
    const result = await q.getEdgeCount.get(uid);
    return result?.c || 0;
};
