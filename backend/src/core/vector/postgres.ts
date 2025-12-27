import { VectorStore } from "../vector_store";
import { log } from "../log";
import { cosineSimilarity, bufferToVector, vectorToBuffer } from "../../memory/embed";
import { DbOps } from "../schema/initial";

export class PostgresVectorStore implements VectorStore {
    private table: string;

    constructor(private db: DbOps, tableName: string = "vectors") {
        this.table = tableName;
    }

    private pgvectorAvailable = false;

    async init(): Promise<void> {
        // Check if optional 'v_vector' column exists and is of vector type
        try {
            const col = await this.db.get_async(
                `select data_type from information_schema.columns where table_name=$1 and column_name='v_vector'`,
                [this.table]
            );
            if (col && typeof col.data_type === 'string' && col.data_type.startsWith('vector')) {
                this.pgvectorAvailable = true;
                log.info(`[DB] pgvector column detected on ${this.table}; future searches can use DB-side vector ops`);
            }
        } catch (e) {
            // Ignore - information_schema may not be accessible under some permissions
        }
    }

    async storeVector(id: string, sector: string, vector: number[], dim: number, user_id?: string): Promise<void> {
        const v = vectorToBuffer(vector);
        const sql = `insert into ${this.table}(id,sector,user_id,v,dim) values($1,$2,$3,$4,$5) on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim`;
        await this.db.run_async(sql, [id, sector, user_id || "anonymous", v, dim]);
    }

    async deleteVector(id: string, sector: string): Promise<void> {
        await this.db.run_async(`delete from ${this.table} where id=$1 and sector=$2`, [id, sector]);
    }

    async deleteVectors(id: string): Promise<void> {
        await this.db.run_async(`delete from ${this.table} where id=$1`, [id]);
    }

    async searchSimilar(sector: string, queryVec: number[], topK: number, user_id?: string): Promise<Array<{ id: string; score: number }>> {
        // If pgvector is available, prefer DB-side search for performance
        if (this.pgvectorAvailable) {
            try {
                const vecParam = '[' + queryVec.map((x) => x.toString()).join(',') + ']';
                let sql = `select id, (v_vector <-> $2::vector) as dist from ${this.table} where sector=$1`;
                const params: any[] = [sector, vecParam];
                if (user_id) {
                    sql += ` and user_id=$3`;
                    params.push(user_id);
                }
                sql += ` order by v_vector <-> $2::vector limit ${topK}`;
                const rows = await this.db.all_async(sql, params);
                return rows.map((r: any) => ({ id: r.id, score: 1 / (1 + parseFloat(r.dist)) }));
            } catch (e) {
                log.warn("[DB] pgvector search failed, falling back to in-memory search", { error: e });
                // fallthrough to in-memory
            }
        }

        // Fallback: in-memory cosine similarity (works on bytea 'v' column)
        let sql = `select id,v,dim from ${this.table} where sector=$1`;
        const params: any[] = [sector];
        if (user_id) {
            sql += ` and user_id=$${params.length + 1}`;
            params.push(user_id);
        }
        const rows = await this.db.all_async(sql, params);

        if (rows.length > 10000) {
            log.warn(`[DB] Postgres vector scan is slow with ${rows.length} rows. Consider migrating to pgvector or Valkey.`);
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

    async getVector(id: string, sector: string): Promise<{ vector: number[]; dim: number } | null> {
        const row = await this.db.get_async(`select v,dim from ${this.table} where id=$1 and sector=$2`, [id, sector]);
        if (!row) return null;
        return { vector: bufferToVector(row.v), dim: row.dim };
    }

    async getVectorsById(id: string): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        const rows = await this.db.all_async(`select sector,v,dim from ${this.table} where id=$1`, [id]);
        return rows.map(row => ({ sector: row.sector, vector: bufferToVector(row.v), dim: row.dim }));
    }

    async getVectorsForMemoryIds(ids: string[]): Promise<Array<{ id: string; sector: string; vector: number[]; dim: number }>> {
        if (ids.length === 0) return [];
        // Use ? placeholders which the db wrapper converts to $N for Postgres
        const ph = ids.map(() => "?").join(",");
        const rows = await this.db.all_async(`select id,sector,v,dim from ${this.table} where id in (${ph})`, ids);
        return rows.map(row => ({
            id: row.id,
            sector: row.sector,
            vector: bufferToVector(row.v),
            dim: row.dim
        }));
    }

    async getVectorsBySector(sector: string, user_id?: string): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        let sql = `select id,v,dim from ${this.table} where sector=$1`;
        const params: any[] = [sector];
        if (user_id) {
            sql += ` and user_id=$2`;
            params.push(user_id);
        }
        const rows = await this.db.all_async(sql, params);
        return rows.map(row => ({ id: row.id, vector: bufferToVector(row.v), dim: row.dim }));
    }

    async search(queryVec: number[], topK: number, user_id?: string): Promise<Array<{ id: string; score: number }>> {
        // Postgres implementation (in-memory cosine sim)
        // Optimization note: Since our schema currently uses 'bytea' for 'v', we rely on in-memory cosine similarity.
        // A future upgrade should migrate to pgvector extension and proper vector type for DB-side similarity search.

        // Limit to 10k recent memories to avoid OOM
        let sql = `select id,v from ${this.table}`;
        const params: any[] = [];
        if (user_id) {
            sql += ` where user_id=$1`;
            params.push(user_id);
        }
        sql += ` limit 10000`;

        const rows = await this.db.all_async(sql, params);

        if (rows.length >= 10000) {
            log.warn(`[DB] Postgres vector scan capped at 10k rows. Search results may be incomplete. Consider migrating to pgvector or Valkey.`);
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
}
