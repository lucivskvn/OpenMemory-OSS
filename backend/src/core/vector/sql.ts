import { VectorStore } from "../vector_store";
import { log } from "../log";
import { cosineSimilarity, bufferToVector, vectorToBuffer } from "../../memory/embed";
import { DbOps } from "../schema/initial";

export class SqlVectorStore implements VectorStore {
    private table: string;

    constructor(private db: DbOps, tableName: string = "vectors") {
        this.table = tableName;
    }

    private pgvectorAvailable = false;

    async init(): Promise<void> {
        // Only attempt pgvector checks if we are running on Postgres
        if (this.db.is_pg) {
            try {
                const col = await this.db.get_async(
                    `select data_type from information_schema.columns where table_name=? and column_name='v_vector'`,
                    [this.table]
                );
                if (col && typeof col.data_type === 'string' && col.data_type.startsWith('vector')) {
                    try {
                        const t = await this.db.get_async(
                            `select atttypmod as tmod from pg_attribute where attrelid = ?::regclass and attname = 'v_vector'`,
                            [this.table]
                        );
                        const tmod = t?.tmod || 0;
                        const dim = (tmod && typeof tmod === 'number') ? (tmod - 4) : 0;
                        if (dim > 0) {
                            this.pgvectorAvailable = true;
                            log.info(`[DB] pgvector column detected on ${this.table} with dimension=${dim}; enabling DB-side search`);
                        } else {
                            log.info(`[DB] pgvector column detected on ${this.table} but without explicit dimension; falling back to in-memory`);
                        }
                    } catch (e) {
                         // Fallback check
                         try {
                            await this.db.get_async(`select (v_vector <-> ?::vector) as dist from ${this.table} limit 1`, ['[0]']);
                            this.pgvectorAvailable = true;
                            log.info(`[DB] pgvector operator test succeeded on ${this.table}`);
                        } catch (e2) {
                            log.info(`[DB] pgvector detected but operator test failed`, { error: e2 });
                        }
                    }
                }
            } catch (e) {
                // Ignore schema check errors
            }
        }
    }

    async storeVector(id: string, sector: string, vector: number[], dim: number, user_id?: string): Promise<void> {
        const v = vectorToBuffer(vector);
        // Uses ? for standard SQL (DB adapter handles replacement)
        // Note: SQLite uses INSERT OR REPLACE, PG uses ON CONFLICT.
        // The DB adapter's run_async should ideally abstract this or we use standard ON CONFLICT if generic.
        // SQLite supports ON CONFLICT since 3.24 (2018). Bun's SQLite is likely recent.
        // Let's use the standard ON CONFLICT syntax which works for both recent SQLite and Postgres.

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
        // PGVector path
        if (this.pgvectorAvailable) {
            try {
                const vecParam = '[' + queryVec.map((x) => x.toString()).join(',') + ']';
                let sql = `select id, (v_vector <-> ?::vector) as dist from ${this.table} where sector=?`;
                const params: any[] = [sector, vecParam];
                if (user_id) {
                    sql += ` and user_id=?`;
                    params.push(user_id);
                }
                sql += ` order by v_vector <-> ?::vector limit ${topK}`;
                // We need to pass the vector again for the ORDER BY clause if strictly parametrised?
                // Actually Postgres allows reusable params or we can use the same param index.
                // But our db adapter converts ? to $1, $2... so we need to be careful.
                // The DB adapter `convertPlaceholders` increments index.
                // So: sector=$1, vector=$2. order by vector <-> $3?
                // We need to push the vector param twice to be safe with the simple converter.
                params.push(vecParam);

                const rows = await this.db.all_async(sql, params);
                return rows.map((r: any) => ({ id: r.id, score: 1 / (1 + parseFloat(r.dist)) }));
            } catch (e) {
                log.warn("[DB] pgvector search failed, falling back to in-memory search", { error: e });
            }
        }

        // Standard SQL / SQLite path (In-Memory)
        let sql = `select id,v,dim from ${this.table} where sector=?`;
        const params: any[] = [sector];
        if (user_id) {
            sql += ` and user_id=?`;
            params.push(user_id);
        }

        // Safety limit for in-memory scan
        // sql += ` limit 20000`;

        const rows = await this.db.all_async(sql, params);

        if (rows.length > 10000) {
            log.warn(`[DB] Vector scan is handling ${rows.length} rows. Performance may degrade.`);
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
        const row = await this.db.get_async(`select v,dim from ${this.table} where id=? and sector=?`, [id, sector]);
        if (!row) return null;
        return { vector: bufferToVector(row.v), dim: row.dim };
    }

    async getVectorsById(id: string): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        const rows = await this.db.all_async(`select sector,v,dim from ${this.table} where id=?`, [id]);
        return rows.map(row => ({ sector: row.sector, vector: bufferToVector(row.v), dim: row.dim }));
    }

    async getVectorsForMemoryIds(ids: string[]): Promise<Array<{ id: string; sector: string; vector: number[]; dim: number }>> {
        if (ids.length === 0) return [];
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
        let sql = `select id,v,dim from ${this.table} where sector=?`;
        const params: any[] = [sector];
        if (user_id) {
            sql += ` and user_id=?`;
            params.push(user_id);
        }
        const rows = await this.db.all_async(sql, params);
        return rows.map(row => ({ id: row.id, vector: bufferToVector(row.v), dim: row.dim }));
    }

    async search(queryVec: number[], topK: number, user_id?: string): Promise<Array<{ id: string; score: number }>> {
        // Global search (no sector filter) - In-memory only for now unless we implement global IVFFlat
        let sql = `select id,v from ${this.table}`;
        const params: any[] = [];
        if (user_id) {
            sql += ` where user_id=?`;
            params.push(user_id);
        }
        sql += ` limit 10000`;

        const rows = await this.db.all_async(sql, params);

        if (rows.length >= 10000) {
            log.warn(`[DB] Vector scan capped at 10k rows.`);
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
