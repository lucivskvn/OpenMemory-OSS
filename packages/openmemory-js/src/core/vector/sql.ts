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
    vectorToBuffer,
} from "../../utils/vectors";
import { env } from "../cfg";
import { applySqlUser, SqlValue } from "../db_utils";
import { VectorStore } from "../vector_store";

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
    v: Buffer;
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
        const isPg =
            env.vectorBackend === "postgres" ||
            env.metadataBackend === "postgres";
        const v = isPg
            ? `[${vector.join(",")}]`
            : new Uint8Array(vectorToBuffer(vector));
        const uid = normalizeUserId(userId);
        const metaStr = metadata ? JSON.stringify(metadata) : null;
        const placeholders = isPg ? "$1, $2, $3, $4, $5, $6" : "?, ?, ?, ?, ?, ?";
        const sql = `insert into ${this.table}(id,sector,user_id,v,dim,metadata) values(${placeholders}) on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim,metadata=excluded.metadata`;
        await this.db.runAsync(sql, [id, sector, uid ?? null, v, dim, metaStr]);
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
            for (let i = 0; i < items.length; i += BATCH_SIZE) {
                const chunk = items.slice(i, i + BATCH_SIZE);
                const params: SqlValue[] = [];
                const rows: string[] = [];
                let idx = 1;
                for (const item of chunk) {
                    const vectorString = `[${item.vector.join(",")}]`;
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
                const sql = `insert into ${this.table}(id,sector,user_id,v,dim,metadata) values ${rows.join(",")} on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim,metadata=excluded.metadata`;
                await this.db.runAsync(sql, params);
            }
        } else {
            // SQLite/Fallback: Sequential or transaction batch
            const runBatch = async () => {
                for (const item of items) {
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
                for (const [key, val] of Object.entries(filter.metadata)) {
                    if (val !== undefined) {
                        whereClause += ` AND json_extract(metadata, '$.' || ?) = ? `;
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

        // JS Fallback (SQLite or non-pgvector)
        // Optimized for Sustainability: Uses streaming iterator to prevent OOM on large datasets
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
        // We rely on DbOps providing iterateAsync (which core/db.ts now does)
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
            } catch (e) { /* skip */ }
        }

        sims.sort((a, b) => b.score - a.score);
        return sims.slice(0, topK);
    }

    async getVector(
        id: string,
        sector: string,
        userId?: string | null,
    ): Promise<{ vector: number[]; dim: number } | null> {
        const uid = normalizeUserId(userId);
        const { sql, params } = applySqlUser(
            `select v,dim from ${this.table} where id=? and sector=?`,
            [id, sector],
            uid,
        );
        const row = await this.db.getAsync<VectorRow>(sql, params);
        if (!row) return null;
        try {
            return { vector: bufferToVector(row.v), dim: row.dim };
        } catch (e) {
            logger.error(
                `[Vector] Corrupted vector for ID ${id} in sector ${sector}`,
                { error: e },
            );
            return null;
        }
    }

    async getVectorsById(
        id: string,
        userId?: string | null,
    ): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        const rows = await this.getVectorsByIds([id], userId);
        return rows.map((r) => ({
            sector: r.sector,
            vector: r.vector,
            dim: r.dim,
        }));
    }

    async getVectorsByIds(
        ids: string[],
        userId?: string | null,
    ): Promise<
        Array<{ id: string; sector: string; vector: number[]; dim: number }>
    > {
        if (ids.length === 0) return [];

        const uid = normalizeUserId(userId);
        const safePlaceholders = ids.map(() => "?").join(",");
        const { sql, params: safeParams } = applySqlUser(
            `select id,sector,v,dim from ${this.table} where id IN (${safePlaceholders})`,
            [...ids],
            uid,
        );

        const rows = await this.db.allAsync<VectorRow>(sql, safeParams);
        return rows.map((r) => ({
            id: r.id,
            sector: r.sector,
            vector: bufferToVector(r.v),
            dim: r.dim,
        }));
    }

    async getVectorsBySector(
        sector: string,
        userId?: string | null,
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        const uid = normalizeUserId(userId);
        const { sql, params } = applySqlUser(
            `select id,v,dim from ${this.table} where sector=?`,
            [sector],
            uid,
        );
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

        if (isPg) {
            const sql = `delete from ${this.table} where user_id = $1`;
            await this.db.runAsync(sql, [uid]);
        } else {
            const sql = `delete from ${this.table} where user_id = ?`;
            await this.db.runAsync(sql, [uid]);
        }
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
}
