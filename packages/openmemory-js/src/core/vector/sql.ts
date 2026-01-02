import { VectorStore } from "../vector_store";
import { cosineSimilarity, bufferToVector, vectorToBuffer } from "../../utils/vectors";
import { env } from "../cfg";

export interface DbOps {
    run_async: (sql: string, params?: any[]) => Promise<number>;
    get_async: (sql: string, params?: any[]) => Promise<any>;
    all_async: (sql: string, params?: any[]) => Promise<any[]>;
}

export class SqlVectorStore implements VectorStore {
    private table: string;

    constructor(private db: DbOps, tableName: string = "vectors") {
        this.table = tableName;
    }

    async storeVector(id: string, sector: string, vector: number[], dim: number, user_id?: string): Promise<void> {
        if (env.verbose) console.error(`[Vector] Storing ID: ${id}, Sector: ${sector}, Dim: ${dim}`);
        const v = vectorToBuffer(vector);
        const sql = `insert into ${this.table}(id,sector,user_id,v,dim) values(?,?,?,?,?) on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim`;
        await this.db.run_async(sql, [id, sector, user_id || "anonymous", v, dim]);
    }

    async deleteVector(id: string, sector: string): Promise<void> {
        await this.db.run_async(`delete from ${this.table} where id=? and sector=?`, [id, sector]);
    }

    async deleteVectors(id: string): Promise<void> {
        await this.db.run_async(`delete from ${this.table} where id=?`, [id]);
    }

    async searchSimilar(sector: string, queryVec: number[], topK: number, user_id?: string): Promise<Array<{ id: string; score: number }>> {
        // Optimization: Use pgvector's cosine distance operator (<=>) if using Postgres
        // Note: <=> returns distance (0..2), so similarity = 1 - distance/2 roughly, or just rank by distance ASC
        // We assume cosine_similarity function might not exist, but <=> operator does if pgvector is installed.
        // However, safely detecting "is postgres" here requires looking at `env.vector_backend`.

        if (process.env.OM_VECTOR_BACKEND === 'postgres') {
            // For pgvector, we want 1 - (cosine distance). 
            // pgvector <=> operator returns cosine distance.
            // ORDER BY v <=> '[...]' ASC LIMIT k
            const vecStr = `[${queryVec.join(",")}]`;
            const user_clause = user_id ? `and user_id = $2` : `and user_id IS NULL`;
            const params = user_id ? [sector, user_id] : [sector];

            const sql = `
                SELECT id, 1 - (v <=> '${vecStr}') as score 
                FROM ${this.table} 
                WHERE sector = $1 ${user_clause}
                ORDER BY v <=> '${vecStr}' ASC
                LIMIT ${topK}
             `;

            // We need to use database-specific parameter placeholder syntax if we are bypassing the generic wrapper
            // But our `db.all_async` wrapper handles ? -> $n conversion (if it's the one from core/db).
            // Wait, `this.db.all_async` might be just the raw wrapper.
            // The safest way is to stick to the wrapper's convention.

            // Important: The `v <=> ?` syntax might not work with string-bound parameters in some drivers,
            // often specific casting `?::vector` is needed.
            // Let's rely on the fact that we can interpolate the vector string safely since it's just numbers.

            try {
                const rows = await this.db.all_async(sql, params);
                return rows.map(r => ({ id: r.id, score: r.score }));
            } catch (e) {
                if (env.verbose) console.error("[Vector] pgvector search failed (fallback to JS):", e);
                // Fallback to JS implementation
            }
        }

        // Fallback: Generic SQL implementation (in-memory cosine sim)
        // This works for both SQLite and Postgres (without pgvector)
        let sql = `select id,v,dim from ${this.table} where sector=?`;
        const params: any[] = [sector];
        if (user_id) {
            sql += ` and user_id=?`;
            params.push(user_id);
        }
        const rows = await this.db.all_async(sql, params);
        if (env.verbose) {
            console.error(`[Vector] Search Sector: ${sector}, Found ${rows.length} rows.`);
        }
        const sims: Array<{ id: string; score: number }> = [];
        for (const row of rows) {
            const vec = bufferToVector(row.v);
            const sim = cosineSimilarity(queryVec, vec);
            sims.push({ id: row.id, score: sim });
        }
        sims.sort((a, b) => b.score - a.score);
        return sims.slice(0, topK);
    }

    async getVector(id: string, sector: string, user_id?: string): Promise<{ vector: number[]; dim: number } | null> {
        let sql = `select v,dim from ${this.table} where id=? and sector=?`;
        const params: any[] = [id, sector];
        if (user_id) {
            sql += ` and user_id=?`;
            params.push(user_id);
        }
        const row = await this.db.get_async(sql, params);
        if (!row) return null;
        return { vector: bufferToVector(row.v), dim: row.dim };
    }

    async getVectorsById(id: string, user_id?: string): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        let sql = `select sector,v,dim from ${this.table} where id=?`;
        const params: any[] = [id];
        if (user_id) {
            sql += ` and user_id=?`;
            params.push(user_id);
        }
        const rows = await this.db.all_async(sql, params);
        return rows.map(row => ({ sector: row.sector, vector: bufferToVector(row.v), dim: row.dim }));
    }

    async getVectorsBySector(sector: string, user_id?: string): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        let sql = `select id,v,dim from ${this.table} where sector=?`;
        const params: any[] = [sector];
        if (user_id) {
            sql += ` and user_id=?`;
            params.push(user_id);
        } else {
            sql += ` and user_id IS NULL`;
        }
        const rows = await this.db.all_async(sql, params);
        return rows.map(row => ({ id: row.id, vector: bufferToVector(row.v), dim: row.dim }));
    }

    async disconnect(): Promise<void> {
        // No-op for SQL store as it shares the main DB connection which is closed separately
        return;
    }
}
