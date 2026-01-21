/**
 * SQL-based Vector Store Implementation.
 * Supports both pgvector (Postgres) and blob-based storage (SQLite) with JS-fallback search.
 */
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import {
    bufferToFloat32Array,
    bufferToVector,
    cosineSimilarity,
    vectorToUint8Array,
} from "../../utils/vectors";
import { env } from "../cfg";
import { applySqlUser, SqlValue } from "../db_utils";
import { VectorStore } from "../vector_store";
import { vecCache } from "./cache";

export interface DbOps {
    runAsync: (sql: string, params?: SqlValue[]) => Promise<number>;
    getAsync: <T = unknown>(
        sql: string,
        params?: SqlValue[],
    ) => Promise<T | undefined>;
    allAsync: <T = unknown>(sql: string, params?: SqlValue[]) => Promise<T[]>;
    transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
    iterateAsync: <T = unknown>( // Made required for standard compliance
        sql: string,
        params?: SqlValue[],
    ) => AsyncIterable<T>;
}

interface VectorRow {
    id: string;
    sector: string;
    v: Uint8Array;
    dim: number;
    score?: number;
}

export class SqlVectorStore implements VectorStore {
    private table: string;

    constructor(
        private db: DbOps,
        tableName: string = "vectors",
    ) {
        this.table = tableName;
    }

    async storeVector(
        id: string,
        sector: string,
        vector: number[],
        dim: number,
        userId?: string | null,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        if (env.verbose)
            logger.debug(
                `[Vector] Storing ID: ${id}, Sector: ${sector}, Dim: ${dim}`,
            );

        if (!vector || vector.length !== dim) {
            throw new Error(`[Vector] Dimension Mismatch: Expected ${dim}, got ${vector?.length}`);
        }

        const isPg =
            env.vectorBackend === "postgres" ||
            env.metadataBackend === "postgres";
        const v = isPg
            ? `[${vector.join(",")}]`
            : vectorToUint8Array(vector);
        const uid = normalizeUserId(userId);
        const metaStr = metadata ? JSON.stringify(metadata) : null;
        const placeholders = isPg ? "$1, $2, $3, $4, $5, $6" : "?, ?, ?, ?, ?, ?";
        const sql = `insert into ${this.table}(id,sector,user_id,v,dim,metadata) values(${placeholders}) on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim,metadata=excluded.metadata`;
        await this.db.runAsync(sql, [id, sector, uid ?? null, v, dim, metaStr]);

        // Cache Update
        // We need to be careful: vecCache stores generic list.
        // We should invalidate IF we don't know current list, OR retrieve-and-update.
        // Simple strategy: Invalidate ID to force fresh fetch on next read.
        vecCache.delete(id);
    }

    async storeVectors(
        items: Array<{
            id: string;
            sector: string;
            vector: number[];
            dim: number;
            metadata?: Record<string, unknown>;
        }>,
        userId?: string | null,
    ): Promise<void> {
        if (items.length === 0) return;
        const uid = normalizeUserId(userId);
        const isPg =
            env.vectorBackend === "postgres" ||
            env.metadataBackend === "postgres";

        if (isPg) {
            // Postgres supports large batches, but we chunk to be safe (e.g. 1000 items)
            const BATCH_SIZE = 1000;
            const runPgBatch = async () => {
                for (let i = 0; i < items.length; i += BATCH_SIZE) {
                    const chunk = items.slice(i, i + BATCH_SIZE);
                    const params: SqlValue[] = [];
                    const rows: string[] = [];
                    let idx = 1;
                    for (const item of chunk) {
                        const vectorString = `[${item.vector.join(",")}]`;
                        if (item.vector.length !== item.dim) {
                            logger.warn(`[Vector] Batch Dim Mismatch for ID ${item.id}: Expected ${item.dim}, got ${item.vector.length}. Skipping.`);
                            continue;
                        }
                        const metaStr = item.metadata ? JSON.stringify(item.metadata) : null;
                        params.push(
                            item.id,
                            item.sector,
                            uid,
                            vectorString,
                            item.dim,
                            metaStr,
                        );
                        rows.push(
                            `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
                        );
                    }
                    if (rows.length === 0) continue;
                    const sql = `insert into ${this.table}(id,sector,user_id,v,dim,metadata) values ${rows.join(",")} on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim,metadata=excluded.metadata`;
                    await this.db.runAsync(sql, params);
                }
            };

            // Wrap in transaction if available
            if (this.db.transaction) await this.db.transaction(runPgBatch);
            else await runPgBatch();

        } else {
            // SQLite/Fallback: Sequential or transaction batch
            const runBatch = async () => {
                for (const item of items) {
                    if (item.vector.length !== item.dim) {
                        logger.warn(`[Vector] Batch Dim Mismatch for ID ${item.id}: Expected ${item.dim}, got ${item.vector.length}. Skipping.`);
                        continue;
                    }
                    await this.storeVector(
                        item.id,
                        item.sector,
                        item.vector,
                        item.dim,
                        userId,
                        item.metadata,
                    );
                }
            };
            if (this.db.transaction) await this.db.transaction(runBatch);
            else await runBatch();
        }

        // Invalidate Cache for all IDs
        for (const item of items) {
            vecCache.delete(item.id);
        }
    }

    async deleteVector(
        id: string,
        sector: string,
        userId?: string | null,
    ): Promise<void> {
        const uid = normalizeUserId(userId);
        const { sql, params } = applySqlUser(
            `delete from ${this.table} where id=? and sector=?`,
            [id, sector],
            uid,
        );
        await this.db.runAsync(sql, params);
        vecCache.delete(id);
    }

    async deleteVectors(ids: string[], userId?: string | null): Promise<void> {
        if (ids.length === 0) return;
        const uid = normalizeUserId(userId);

        // Chunking to avoid "too many SQL variables" (SQLite limit ~999)
        // We use a safe batch size of 200 IDs per delete
        const BATCH_SIZE = 200;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const chunk = ids.slice(i, i + BATCH_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const { sql, params } = applySqlUser(
                `delete from ${this.table} where id IN (${placeholders})`,
                [...chunk],
                uid,
            );
            await this.db.runAsync(sql, params);
        }
        for (const id of ids) vecCache.delete(id);
    }

    async searchSimilar(
        sector: string,
        queryVec: number[],
        topK: number,
        userId?: string | null,
        filter?: { metadata?: Record<string, unknown> },
    ): Promise<Array<{ id: string; score: number }>> {
        const uid = normalizeUserId(userId);
        let whereClause = "";
        const extraParams: SqlValue[] = [];

        if (filter?.metadata) {
            const isPg = env.vectorBackend === "postgres";
            if (isPg) {
                // Postgres native JSONB containment
                whereClause += ` AND metadata @> ? `;
                extraParams.push(JSON.stringify(filter.metadata));
            } else {
                // SQLite json_extract for each key
                // Use json_each for more robust matching of primitive values vs JSON strings
                for (const [key, val] of Object.entries(filter.metadata)) {
                    if (val !== undefined) {
                        whereClause += ` AND json_extract(metadata, '$.' || ?) = ? `;
                        // SQLite json_extract returns the value. 
                        // If it's a string, it returns the string. 
                        // However, if we comparison with a value that came from JSON.stringify, it might be double-quoted.
                        // Actually, json_extract in SQLite is smart, but let's be safe.
                        extraParams.push(key, val as SqlValue);
                    }
                }
            }
        }

        if (env.vectorBackend === "postgres") {
            const vectorString = `[${queryVec.join(",")}]`;

            // Re-construct the query with native JSONB filtering
            let sql = "";
            let params: SqlValue[] = [];

            sql = `
                SELECT id, 1 - (v <=> $1) as score 
                FROM ${this.table}
                WHERE sector = $2
                ${whereClause}
             `;
            params = [vectorString, sector, ...extraParams];

            // User Logic
            if (uid === null) {
                sql += " AND user_id IS NULL";
            } else if (uid !== undefined) {
                sql += " AND user_id = $" + (params.length + 1);
                params.push(uid);
            }

            sql += ` ORDER BY v <=> $1 ASC LIMIT ${topK}`;

            // Fix placeholders for Postgres ($1, $2...)
            let pIdx = 3; // $1=vec, $2=sector
            sql = sql.replace(/\?/g, () => `$${pIdx++}`);

            try {
                const rows = await this.db.allAsync<{
                    id: string;
                    score: number;
                }>(sql, params);
                return rows.map((r) => ({ id: r.id, score: r.score }));
            } catch (error: unknown) {
                logger.warn(
                    "[Vector] pgvector search failed (likely extension not enabled), using JS fallback.",
                    { error },
                );
            }
        }

        // Log warning if fallback is used in what should be a PG env
        if (env.vectorBackend === "postgres") {
            logger.warn("[Vector] Performing SLOW JS-based vector search. Ensure 'pgvector' extension is enabled on your Postgres instance.");
        }

        // JS Fallback (SQLite or non-pgvector)
        // Optimized for Sustainability: Uses streaming iterator to prevent OOM on large datasets
        // logger.debug(`[Vector] Using search fallback on table: ${this.table}`);
        let sql = `select id, v, dim from ${this.table} where sector=?`;
        const params: SqlValue[] = [sector];

        if (whereClause) {
            sql += whereClause;
            params.push(...extraParams);
        }

        if (uid !== undefined) {
            if (uid === null) sql += ` and user_id IS NULL`;
            else {
                sql += ` and user_id=?`;
                params.push(uid);
            }
        }

        const sims: Array<{ id: string; score: number }> = [];
        // Use Float32Array for query vector (zero copy if possible)
        const qVec = new Float32Array(queryVec);

        // Streaming Implementation (Memory Efficient)
        const iterator = this.db.iterateAsync<VectorRow>(sql, params);
        for await (const row of iterator) {
            if (!row.v) continue;
            try {
                // Zero-copy conversion if possible
                const vec = bufferToFloat32Array(row.v);
                if (vec.length !== qVec.length) continue;
                const sim = cosineSimilarity(qVec, vec); // Optimized

                // Only keep candidates that might be relevant? 
                // For now, allow full scan but sort later. A heap would be better for topK but JS sort is fast enough for localized filtered sets.
                sims.push({ id: row.id, score: sim });
            } catch (e) {
                logger.debug("[Vector] Failed to parse vector in search fallback", { id: row.id, error: e });
            }
        }

        sims.sort((a, b) => b.score - a.score);
        return sims.slice(0, topK);
    }

    async getVector(
        id: string,
        sector: string,
        userId?: string | null,
    ): Promise<{ vector: number[]; dim: number; metadata?: Record<string, unknown> } | null> {
        // Leverages the cached getVectorsByIds
        const rows = await this.getVectorsByIds([id], userId);
        const match = rows.find(r => r.sector === sector);
        return match ? { vector: match.vector, dim: match.dim, metadata: match.metadata } : null;
    }

    async getVectorsById(
        id: string,
        userId?: string | null,
    ): Promise<Array<{ sector: string; vector: number[]; dim: number; metadata?: Record<string, unknown> }>> {
        const rows = await this.getVectorsByIds([id], userId);
        return rows.map((r) => ({
            sector: r.sector,
            vector: r.vector,
            dim: r.dim,
            metadata: r.metadata
        }));
    }

    async getVectorsByIds(
        ids: string[],
        userId?: string | null,
    ): Promise<
        Array<{ id: string; sector: string; vector: number[]; dim: number; metadata?: Record<string, unknown> }>
    > {
        if (ids.length === 0) return [];
        const uid = normalizeUserId(userId);

        const results: Array<{ id: string; sector: string; vector: number[]; dim: number; metadata?: Record<string, unknown> }> = [];
        const missingIds: string[] = [];

        // 1. Check Cache
        for (const id of ids) {
            const cached = vecCache.get(id);
            if (cached) {
                for (const c of cached) {
                    // Strict check: if uid is undefined (System), allow all.
                    // If uid is null (Anonymous), only allow c.userId === null.
                    // If uid is string, only allow match.
                    if (uid === undefined || c.userId === uid) {
                        results.push({
                            id: c.id,
                            sector: c.sector,
                            vector: Array.from(c.vector), // Inflate
                            dim: c.dim,
                            metadata: (c as any).metadata
                        });
                    }
                }
            } else {
                missingIds.push(id);
            }
        }

        if (missingIds.length === 0) return results;

        // 2. Fetch Missing
        const safePlaceholders = missingIds.map(() => "?").join(",");
        const { sql, params: safeParams } = applySqlUser(
            `select id, sector, user_id as userId, v, dim, metadata from ${this.table} where id IN (${safePlaceholders})`,
            [...missingIds],
            uid,
        );

        const rows = await this.db.allAsync<VectorRow & { userId?: string, metadata?: string }>(sql, safeParams);

        // 3. Populate Cache & Results
        // Group by ID to populate cache
        const byId = new Map<string, Array<{ id: string; sector: string; vector: Float32Array; dim: number; userId: string | null; metadata?: Record<string, unknown> }>>();

        for (const r of rows) {
            try {
                const vector = bufferToFloat32Array(r.v); // Optimized: kept as F32
                const metadata = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
                const item = {
                    id: r.id,
                    sector: r.sector,
                    vector,
                    dim: r.dim,
                    // Handle both raw column and camelCased mapping from db_access
                    userId: (r as any).userId ?? (r as any).user_id ?? null,
                    metadata
                };

                // Add to results
                results.push({
                    id: item.id,
                    sector: item.sector,
                    vector: Array.from(item.vector),
                    dim: item.dim,
                    metadata: item.metadata
                });

                if (!byId.has(r.id)) byId.set(r.id, []);
                byId.get(r.id)!.push(item);

            } catch (e) {
                logger.debug("[Vector] Failed to parse vector in getVectorsByIds", { id: r.id, error: e });
            }
        }

        // Update Cache
        for (const [id, items] of byId.entries()) {
            vecCache.set(id, items);
        }

        return results;
    }

    async getVectorsBySector(
        sector: string,
        userId?: string | null,
        limit: number = 1000,
        offset: number = 0,
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        const uid = normalizeUserId(userId);
        const { sql: userSql, params: userParams } = applySqlUser(
            `select id, v, dim, user_id as userId from ${this.table} where sector=?`,
            [sector],
            uid,
        );

        // Append pagination
        const sql = `${userSql} LIMIT ? OFFSET ?`;
        // Cast to SqlValue (number is valid)
        const params = [...userParams, limit, offset];

        const rows = await this.db.allAsync<VectorRow>(sql, params);
        return rows.map((r) => ({
            id: r.id,
            vector: bufferToVector(r.v),
            dim: r.dim,
        }));
    }

    async deleteVectorsByUser(userId: string): Promise<void> {
        const uid = normalizeUserId(userId);
        if (!uid) return;

        const isPg =
            env.vectorBackend === "postgres" ||
            env.metadataBackend === "postgres";

        // Fetch IDs to invalidate cache
        // We do this before delete to ensure we know what to remove
        let ids: string[] = [];
        try {
            const idSql = isPg
                ? `select distinct id from ${this.table} where user_id = $1`
                : `select distinct id from ${this.table} where user_id = ?`;
            const rows = await this.db.allAsync<{ id: string }>(idSql, [uid]);
            ids = rows.map(r => r.id);
        } catch (e) {
            logger.warn(`[Vector] Failed to fetch IDs for cache invalidation during user wipe`, { error: e });
        }

        if (isPg) {
            const sql = `delete from ${this.table} where user_id = $1`;
            await this.db.runAsync(sql, [uid]);
        } else {
            const sql = `delete from ${this.table} where user_id = ?`;
            await this.db.runAsync(sql, [uid]);
        }

        // Invalidate Cache
        for (const id of ids) vecCache.delete(id);
    }

    async getAllVectorIds(userId?: string | null): Promise<Set<string>> {
        const uid = normalizeUserId(userId);
        // Optimization: We only need distinct IDs.
        const { sql, params } = applySqlUser(
            `select distinct id from ${this.table}`,
            [],
            uid,
        );
        const rows = await this.db.allAsync<{ id: string }>(sql, params);
        return new Set(rows.map((r) => r.id));
    }
    async *iterateVectorIds(userId?: string | null): AsyncIterable<string> {
        const uid = normalizeUserId(userId);
        // Optimization: We only need distinct IDs.
        const { sql, params } = applySqlUser(
            `select distinct id from ${this.table}`,
            [],
            uid,
        );
        logger.debug(`[Vector] Iterating IDs from ${this.table}`, { sql, params });
        const iterator = this.db.iterateAsync<{ id: string }>(sql, params);
        for await (const row of iterator) {
            yield row.id;
        }
    }

    async cleanupOrphanedVectors(userId?: string | null): Promise<{ deleted: number }> {
        const uid = normalizeUserId(userId);
        // Correctly handle table name and scoping. 
        // We use a subquery to find vectors whose ID exists in the memories table.
        // Important: this.table might be different from "vectors" if configured.
        const sql = `
            delete from ${this.table} 
            where (select count(*) from memories where memories.id = ${this.table}.id) = 0
        `;
        // applySqlUser will append 'and user_id = ?' correctly
        const { sql: finalizedSql, params } = applySqlUser(sql, [], uid);

        logger.debug("[Vector] cleanupOrphanedVectors execute", { finalizedSql, params });
        const deleted = await this.db.runAsync(finalizedSql, params);
        logger.debug("[Vector] cleanupOrphanedVectors result", { deleted });

        return { deleted };
    }
}
