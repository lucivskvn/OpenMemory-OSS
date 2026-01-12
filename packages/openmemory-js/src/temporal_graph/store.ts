/**
 * Temporal Knowledge Graph Store for OpenMemory.
 * Handles persistence, versioning, and temporal consistency of facts and edges.
 */
import { env } from "../core/cfg";
import {
    allAsync,
    getAsync,
    runAsync,
    SqlParams,
    TABLES,
    transaction,
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
export const insertFact = async (
    subject: string,
    predicate: string,
    object: string,
    validFrom: Date = new Date(),
    confidence: number = 1.0,
    metadata?: Record<string, unknown>,
    userId?: string | null,
): Promise<string> => {
    const id = globalThis.crypto.randomUUID();
    const now = Date.now();
    const validFromTs = validFrom.getTime();

    // Standardize userId
    const uid = normalizeUserId(userId);

    // Use transaction for atomic "close old and insert new" or "update existing"
    return await transaction.run(async () => {
        // First check: Do we already have this EXACT fact active?
        // If so, just update confidence and metadata rather than closing/reopening.
        // Integrity: Added FOR UPDATE for Postgres to prevent concurrent updates/inserts for same fact
        let matchSql = `
            SELECT id, confidence, valid_from FROM ${TABLES.temporal_facts} 
            WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL
        `;
        if (env.metadataBackend === "postgres") {
            matchSql += " FOR UPDATE";
        }
        const matchParams: SqlParams = [subject, predicate, object];
        if (uid !== undefined) {
            matchSql +=
                uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) matchParams.push(uid);
        }

        const match = await getAsync<TemporalFactRow>(matchSql, matchParams);
        if (match) {
            if (env.verbose) {
                logger.debug(
                    `[TEMPORAL] Existing active fact found for ${subject} ${predicate} ${object}. Updating instead of inserting.`,
                );
            }
            // Update confidence (take the max of existing and new) and bump last_updated
            const newConfidence = Math.max(match.confidence, confidence);
            await runAsync(
                `
                UPDATE ${TABLES.temporal_facts} 
                SET confidence = ?, last_updated = ?, metadata = ? 
                WHERE id = ?
            `,
                [
                    newConfidence,
                    now,
                    metadata
                        ? await getEncryption().encrypt(
                            JSON.stringify(metadata),
                        )
                        : null,
                    match.id,
                ],
            );

            eventBus.emit(EVENTS.TEMPORAL_FACT_UPDATED, {
                id: match.id,
                userId: uid ?? undefined,
                confidence: newConfidence,
                metadata,
            });
            return match.id;
        }

        // Second check: If not an exact match, check for overlapping facts for the same subject/predicate.
        // These will be "closed" to make room for the new fact (replaces old knowledge).
        // Integrity: Added FOR UPDATE for Postgres to ensure we own the timeline for this subject-predicate
        let sql = `
            SELECT id, valid_from, valid_to FROM ${TABLES.temporal_facts} 
            WHERE subject = ? AND predicate = ? AND (valid_to IS NULL OR valid_to > ?)
        `;
        if (env.metadataBackend === "postgres") {
            sql += " FOR UPDATE";
        }
        const params: SqlParams = [subject, predicate, validFromTs];

        if (uid !== undefined) {
            sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) params.push(uid);
        }

        sql += " ORDER BY valid_from ASC";

        const existing = await allAsync<TemporalFactRow>(sql, params);
        let newFactValidTo: number | null = null;

        for (const old of existing) {
            const oldValidFrom = Number(old.validFrom);
            // Case 1: Old fact overlaps with New fact start: Close Old fact at New start.
            if (oldValidFrom < validFromTs) {
                await runAsync(
                    `UPDATE ${TABLES.temporal_facts} SET valid_to = ? WHERE id = ?`,
                    [validFromTs - 1, old.id],
                );
                if (env.verbose) {
                    logger.debug(
                        `[TEMPORAL] Closed fact ${old.id} at ${new Date(validFromTs - 1).toISOString()}`,
                    );
                }
            } else if (oldValidFrom === validFromTs) {
                // Collision: Old fact starts exactly when new fact starts.
                await runAsync(
                    `UPDATE ${TABLES.temporal_facts} SET valid_to = ? WHERE id = ?`,
                    [validFromTs - 1, old.id],
                );
                if (env.verbose) {
                    logger.debug(
                        `[TEMPORAL] Collided fact ${old.id} invalidated at ${new Date(validFromTs - 1).toISOString()}`,
                    );
                }
            }
            // Case 2: Old fact starts AFTER New fact: New fact must end before Old start.
            else if (oldValidFrom > validFromTs) {
                if (
                    newFactValidTo === null ||
                    oldValidFrom - 1 < newFactValidTo
                ) {
                    newFactValidTo = oldValidFrom - 1;
                }
            }
        }

        await runAsync(
            `
            INSERT INTO ${TABLES.temporal_facts} (id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
            [
                id,
                uid ?? null,
                subject,
                predicate,
                object,
                validFromTs,
                newFactValidTo,
                confidence,
                now,
                metadata
                    ? await getEncryption().encrypt(JSON.stringify(metadata))
                    : null,
            ],
        );

        if (env.verbose) {
            logger.debug(
                `[TEMPORAL] Inserted fact: ${subject} ${predicate} ${object} (from ${validFrom.toISOString()} to ${newFactValidTo ? new Date(newFactValidTo).toISOString() : "NULL"})`,
            );
        }
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

/**
 * Updates an existing fact by ID. Can verify ownership.
 * @param id - Fact UUID.
 * @param userId - Owner context.
 * @param confidence - New confidence score.
 * @param metadata - New metadata content.
 */
export const updateFact = async (
    id: string,
    userId?: string | null,
    confidence?: number,
    metadata?: Record<string, unknown>,
): Promise<void> => {
    const updates: string[] = [];
    const params: SqlParams = [];
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

    params.push(id);

    if (updates.length > 0) {
        let sql = `UPDATE ${TABLES.temporal_facts} SET ${updates.join(", ")} WHERE id = ?`;
        if (uid !== undefined) {
            sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) params.push(uid);
        }

        const changes = await runAsync(sql, params);
        if (changes === 0) {
            logger.error(
                `[TEMPORAL] Update failed: Fact ${id} not found for user ${uid === undefined ? "ANY" : uid || "NULL"}`,
            );
        } else {
            if (env.verbose) {
                logger.debug(`[TEMPORAL] Updated fact ${id}`);
            }
            eventBus.emit(EVENTS.TEMPORAL_FACT_UPDATED, {
                id,
                userId: uid ?? undefined,
                confidence,
                metadata,
            });
        }
    }
};

export const invalidateFact = async (
    id: string,
    userId?: string | null,
    validTo: Date = new Date(),
): Promise<void> => {
    const uid = normalizeUserId(userId);

    return await transaction.run(async () => {
        // Integrity: Fetch valid_from to ensure valid_to >= valid_from
        let querySql = `SELECT valid_from FROM ${TABLES.temporal_facts} WHERE id = ?`;
        const queryParams: SqlParams = [id];
        if (uid !== undefined) {
            querySql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) queryParams.push(uid);
        }

        const existing = await getAsync<TemporalFactRow>(querySql, queryParams);

        if (!existing) {
            logger.error(`[TEMPORAL] Invalidation failed: Fact ${id} not found for user ${uid}`);
            return;
        }

        const validFromTs = Number(existing.validFrom);
        const validToTs = validTo.getTime();

        if (validToTs < validFromTs) {
            throw new Error(`[TEMPORAL] Integrity Error: validTo (${new Date(validToTs).toISOString()}) cannot be before validFrom (${new Date(validFromTs).toISOString()})`);
        }

        let sql = `UPDATE ${TABLES.temporal_facts} SET valid_to = ?, last_updated = ? WHERE id = ?`;
        const params: SqlParams = [validToTs, Date.now(), id];
        if (uid !== undefined) {
            sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) params.push(uid);
        }

        const changes = await runAsync(sql, params);
        if (changes > 0) {
            if (env.verbose) {
                logger.debug(
                    `[TEMPORAL] Invalidated fact ${id} at ${validTo.toISOString()}`,
                );
            }
            eventBus.emit(EVENTS.TEMPORAL_FACT_DELETED, {
                id,
                userId: uid ?? undefined,
                validTo: validTo.getTime(),
            });
        }
    });
};

export const deleteFact = async (
    id: string,
    userId?: string | null,
): Promise<void> => {
    const uid = normalizeUserId(userId);

    let sql = `DELETE FROM ${TABLES.temporal_facts} WHERE id = ?`;
    const params: SqlParams = [id];
    if (uid !== undefined) {
        sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
        if (uid !== null) params.push(uid);
    }

    const changes = await runAsync(sql, params);
    if (changes > 0) {
        // Also delete related edges (orphans)
        let edgeSql = `DELETE FROM ${TABLES.temporal_edges} WHERE (source_id = ? OR target_id = ?)`;
        const edgeParams: SqlParams = [id, id];
        if (uid !== undefined) {
            edgeSql +=
                uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) edgeParams.push(uid);
        }
        await runAsync(edgeSql, edgeParams);
        if (env.verbose) {
            logger.debug(`[TEMPORAL] Deleted fact ${id} and related edges`);
        }
    }
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
    const id = globalThis.crypto.randomUUID();
    const validFromTs = validFrom.getTime();
    const uid = normalizeUserId(userId);

    // Use transaction for atomic "close old and insert new" or "update existing"
    return await transaction.run(async () => {
        // First check: Do we already have this EXACT edge active?
        // Integrity: Added FOR UPDATE for Postgres
        let matchSql = `
            SELECT id, weight, valid_from FROM ${TABLES.temporal_edges} 
            WHERE source_id = ? AND target_id = ? AND relation_type = ? AND valid_to IS NULL
        `;
        if (env.metadataBackend === "postgres") {
            matchSql += " FOR UPDATE";
        }
        const matchParams: SqlParams = [sourceId, targetId, relationType];
        if (uid !== undefined) {
            matchSql +=
                uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) matchParams.push(uid);
        }

        const match = await getAsync<TemporalEdgeRow>(matchSql, matchParams);
        if (match) {
            if (env.verbose) {
                logger.debug(
                    `[TEMPORAL] Existing active edge found between ${sourceId} and ${targetId}. Updating.`,
                );
            }
            const now = Date.now();
            const newWeight = Math.max(match.weight || 0, weight);
            await runAsync(
                `
                UPDATE ${TABLES.temporal_edges} 
                SET weight = ?, metadata = ?, last_updated = ? 
                WHERE id = ?
            `,
                [
                    newWeight,
                    metadata
                        ? await getEncryption().encrypt(
                            JSON.stringify(metadata),
                        )
                        : null,
                    now,
                    match.id,
                ],
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

        // Second check: Invalidate existing edges of same type between same nodes if they overlap with the new one
        // Integrity: Added FOR UPDATE for Postgres
        let sql = `
            SELECT id, valid_from FROM ${TABLES.temporal_edges} 
            WHERE source_id = ? AND target_id = ? AND relation_type = ? AND valid_to IS NULL
        `;
        if (env.metadataBackend === "postgres") {
            sql += " FOR UPDATE";
        }
        const params: SqlParams = [sourceId, targetId, relationType];

        if (uid !== undefined) {
            sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) params.push(uid);
        }

        const existing = await allAsync<TemporalEdgeRow>(sql, params);

        for (const old of existing) {
            if (old.validFrom < validFromTs) {
                await runAsync(
                    `UPDATE ${TABLES.temporal_edges} SET valid_to = ? WHERE id = ?`,
                    [validFromTs - 1, old.id],
                );
                if (env.verbose) {
                    logger.debug(
                        `[TEMPORAL] Closed edge ${old.id} at ${new Date(validFromTs - 1).toISOString()}`,
                    );
                }
            }
        }

        const now = Date.now();
        await runAsync(
            `
            INSERT INTO ${TABLES.temporal_edges} (id, user_id, source_id, target_id, relation_type, valid_from, valid_to, weight, last_updated, metadata)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        `,
            [
                id,
                uid ?? null,
                sourceId,
                targetId,
                relationType,
                validFromTs,
                weight,
                now,
                metadata
                    ? await getEncryption().encrypt(JSON.stringify(metadata))
                    : null,
            ],
        );

        if (env.verbose) {
            logger.debug(
                `[TEMPORAL] Created edge: ${sourceId} --[${relationType}]--> ${targetId}`,
            );
        }
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
    const uid = normalizeUserId(userId);

    return await transaction.run(async () => {
        // Integrity: Fetch valid_from to ensure valid_to >= valid_from
        let querySql = `SELECT valid_from FROM ${TABLES.temporal_edges} WHERE id = ?`;
        const queryParams: SqlParams = [id];
        if (uid !== undefined) {
            querySql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) queryParams.push(uid);
        }

        const existing = await getAsync<TemporalEdgeRow>(querySql, queryParams);

        if (!existing) {
            logger.error(`[TEMPORAL] Invalidation failed: Edge ${id} not found for user ${uid}`);
            return;
        }

        const validFromTs = Number(existing.validFrom);
        const validToTs = validTo.getTime();

        if (validToTs < validFromTs) {
            throw new Error(`[TEMPORAL] Integrity Error: validTo (${new Date(validToTs).toISOString()}) cannot be before validFrom (${new Date(validFromTs).toISOString()})`);
        }

        let sql = `UPDATE ${TABLES.temporal_edges} SET valid_to = ? WHERE id = ?`;
        const params: SqlParams = [validToTs, id];
        if (uid !== undefined) {
            sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) params.push(uid);
        }

        const changes = await runAsync(sql, params);
        if (changes > 0) {
            if (env.verbose) {
                logger.debug(`[TEMPORAL] Invalidated edge ${id} at ${validTo.toISOString()}`);
            }
            eventBus.emit(EVENTS.TEMPORAL_EDGE_DELETED, {
                id,
                userId: uid ?? undefined,
                validTo: validTo.getTime(),
            });
        }
    });
};

/**
 * Updates an existing edge by ID. Can verify ownership.
 * @param id - Edge UUID.
 * @param options - New weight or metadata.
 * @param userId - Owner context.
 */
export const updateEdge = async (
    id: string,
    options: { weight?: number; metadata?: Record<string, unknown> },
    userId?: string | null,
): Promise<void> => {
    const updates: string[] = [];
    const params: SqlParams = [];
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

    params.push(id);

    if (updates.length > 0) {
        let sql = `UPDATE ${TABLES.temporal_edges} SET ${updates.join(", ")} WHERE id = ?`;
        if (uid !== undefined) {
            sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (uid !== null) params.push(uid);
        }

        const changes = await runAsync(sql, params);
        if (changes === 0) {
            logger.error(
                `[TEMPORAL] Update edge failed: Edge ${id} not found for user ${uid === undefined ? "ANY" : uid || "NULL"}`,
            );
        } else {
            if (env.verbose) {
                logger.debug(`[TEMPORAL] Updated edge ${id}`);
            }
            eventBus.emit(EVENTS.TEMPORAL_EDGE_UPDATED, {
                id,
                userId: uid ?? undefined,
                weight: options.weight,
                metadata: options.metadata,
                lastUpdated: Date.now(),
            });
        }
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
        if (env.verbose) {
            logger.info(`[TEMPORAL] Batch inserted ${ids.length} facts`);
        }
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
    let userClause = "";
    const params: SqlParams = [decayRate, now, oneDay];
    if (uid !== undefined) {
        userClause = uid === null ? "AND user_id IS NULL" : "AND user_id = ?";
        if (uid !== null) params.push(uid);
    }

    const isPg = env.metadataBackend === "postgres";
    const maxFunc = isPg ? "GREATEST" : "MAX";

    const changes = await runAsync(
        `
        UPDATE ${TABLES.temporal_facts} 
        SET confidence = ${maxFunc}(0.1, confidence * (1.0 - ? * ((? - last_updated) * 1.0 / ?)))
        WHERE valid_to IS NULL AND confidence > 0.1
        ${userClause}
    `,
        params,
    );

    if (env.verbose) {
        logger.info(`[TEMPORAL] Applied confidence decay to ${changes} facts`);
    }
    return changes;
};

export const getActiveFactsCount = async (
    userId?: string | null,
): Promise<number> => {
    const uid = normalizeUserId(userId);
    let sql = `SELECT COUNT(*) as count FROM ${TABLES.temporal_facts} WHERE valid_to IS NULL`;
    const params: SqlParams = [];
    if (uid !== undefined) {
        sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
        if (uid !== null) params.push(uid);
    }
    const result = await getAsync<{ count: number }>(sql, params);
    return Number(result?.count || 0);
};

export const getTotalFactsCount = async (
    userId?: string | null,
): Promise<number> => {
    const uid = normalizeUserId(userId);
    let sql = `SELECT COUNT(*) as count FROM ${TABLES.temporal_facts}`;
    const params: SqlParams = [];
    if (uid !== undefined) {
        sql += uid === null ? " WHERE user_id IS NULL" : " WHERE user_id = ?";
        if (uid !== null) params.push(uid);
    }
    const result = await getAsync<{ count: number }>(sql, params);
    return Number(result?.count || 0);
};

export const getActiveEdgesCount = async (
    userId?: string | null,
): Promise<number> => {
    const uid = normalizeUserId(userId);
    let sql = `SELECT COUNT(*) as count FROM ${TABLES.temporal_edges} WHERE valid_to IS NULL`;
    const params: SqlParams = [];
    if (uid !== undefined) {
        sql += uid === null ? " AND user_id IS NULL" : " AND user_id = ?";
        if (uid !== null) params.push(uid);
    }
    const result = await getAsync<{ count: number }>(sql, params);
    return Number(result?.count || 0);
};

export const getTotalEdgesCount = async (
    userId?: string | null,
): Promise<number> => {
    const uid = normalizeUserId(userId);
    let sql = `SELECT COUNT(*) as count FROM ${TABLES.temporal_edges}`;
    const params: SqlParams = [];
    if (uid !== undefined) {
        sql += uid === null ? " WHERE user_id IS NULL" : " WHERE user_id = ?";
        if (uid !== null) params.push(uid);
    }
    const result = await getAsync<{ count: number }>(sql, params);
    return Number(result?.count || 0);
};
