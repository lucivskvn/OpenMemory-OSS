import { VectorStore } from "../vector_store";
import {
    bufferToVector,
    vectorToBuffer,
    cosineSimilarity,
} from "../../memory/embed";
import { assertSafeIdentifier, DEFAULT_VECTOR_TABLE } from "../identifiers";

export interface DbOps {
    run_async: (sql: string, params?: any[]) => Promise<void>;
    get_async: (sql: string, params?: any[]) => Promise<any>;
    all_async: (sql: string, params?: any[]) => Promise<any[]>;
}

export class PostgresVectorStore implements VectorStore {
    private table: string;
    private usePgVector: boolean;

    constructor(
        private db: DbOps,
        tableName: string = DEFAULT_VECTOR_TABLE,
        usePgVector: boolean = false,
    ) {
        if (tableName.startsWith('"')) {
            this.table = tableName;
        } else {
            this.table = assertSafeIdentifier(tableName, "OM_VECTOR_TABLE");
        }
        this.usePgVector = usePgVector;
        console.error(
            `[PostgresVectorStore] mode: ${usePgVector ? "pgvector (native)" : "sqlite (compat)"}`,
        );
    }

    async storeVector(
        id: string,
        sector: string,
        vector: number[],
        dim: number,
        user_id: string,
        project_id?: string,
    ): Promise<void> {
        if (this.usePgVector) {
            const v_str = JSON.stringify(vector);
            const sql = `insert into ${this.table}(id,sector,user_id,project_id,v,dim) values($1,$2,$3,$4,$5::vector,$6) on conflict(id,sector) do update set user_id=excluded.user_id,project_id=excluded.project_id,v=excluded.v,dim=excluded.dim`;
            await this.db.run_async(sql, [
                id,
                sector,
                user_id,
                project_id || null,
                v_str,
                dim,
            ]);
        } else {
            const v = vectorToBuffer(vector);
            const sql = `insert into ${this.table}(id,sector,user_id,project_id,v,dim) values($1,$2,$3,$4,$5,$6) on conflict(id,sector) do update set user_id=excluded.user_id,project_id=excluded.project_id,v=excluded.v,dim=excluded.dim`;
            await this.db.run_async(sql, [
                id,
                sector,
                user_id,
                project_id || null,
                v,
                dim,
            ]);
        }
    }

    async deleteVector(id: string, sector: string, user_id: string): Promise<void> {
        await this.db.run_async(
            `delete from ${this.table} where id=$1 and sector=$2 and user_id=$3`,
            [id, sector, user_id],
        );
    }

    async deleteVectors(id: string, user_id: string): Promise<void> {
        await this.db.run_async(`delete from ${this.table} where id=$1 and user_id=$2`, [id, user_id]);
    }

    async searchSimilar(
        sector: string,
        queryVec: number[],
        topK: number,
        user_id: string,
        project_id?: string,
    ): Promise<Array<{ id: string; score: number }>> {
        if (this.usePgVector) {
            const v_str = JSON.stringify(queryVec);
            let filter_sql = "where sector = $2 and user_id = $4";
            const args: any[] = [v_str, sector, topK, user_id];

            if (project_id) {
                filter_sql += ` and (project_id = $${args.length + 1} or project_id = 'system_global' or project_id IS NULL)`;
                args.push(project_id);
            }

            const sql = `
                select id, 1 - (v <=> $1::vector) as similarity
                from ${this.table}
                ${filter_sql}
                order by v <=> $1::vector
                limit $3
            `;
            const rows = await this.db.all_async(sql, args);
            return rows.map((r) => ({ id: r.id, score: r.similarity }));
        } else {
            const direct_args: any[] = [sector, user_id];
            let direct_filter = "where sector=$1 and user_id=$2";

            if (project_id) {
                direct_filter += ` and (project_id=$3 or project_id='system_global' or project_id IS NULL)`;
                direct_args.push(project_id);
            }

            const rows = await this.db.all_async(
                `select id,v,dim from ${this.table} ${direct_filter}`,
                direct_args,
            );
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

    async getVector(
        id: string,
        sector: string,
        user_id: string,
    ): Promise<{ vector: number[]; dim: number } | null> {
        if (this.usePgVector) {
            const row = await this.db.get_async(
                `select v::text as v_txt,dim from ${this.table} where id=$1 and sector=$2 and user_id=$3`,
                [id, sector, user_id],
            );
            if (!row) return null;
            return { vector: JSON.parse(row.v_txt), dim: row.dim };
        } else {
            const row = await this.db.get_async(
                `select v,dim from ${this.table} where id=$1 and sector=$2 and user_id=$3`,
                [id, sector, user_id],
            );
            if (!row) return null;
            return { vector: bufferToVector(row.v), dim: row.dim };
        }
    }

    async getVectorsById(
        id: string,
        user_id: string,
    ): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        if (this.usePgVector) {
            const rows = await this.db.all_async(
                `select sector,v::text as v_txt,dim from ${this.table} where id=$1 and user_id=$2`,
                [id, user_id],
            );
            return rows.map((row) => ({
                sector: row.sector,
                vector: JSON.parse(row.v_txt),
                dim: row.dim,
            }));
        } else {
            const rows = await this.db.all_async(
                `select sector,v,dim from ${this.table} where id=$1 and user_id=$2`,
                [id, user_id],
            );
            return rows.map((row) => ({
                sector: row.sector,
                vector: bufferToVector(row.v),
                dim: row.dim,
            }));
        }
    }

    async getVectorsBySector(
        sector: string,
        user_id: string,
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        if (this.usePgVector) {
            const rows = await this.db.all_async(
                `select id,v::text as v_txt,dim from ${this.table} where sector=$1 and user_id=$2`,
                [sector, user_id],
            );
            return rows.map((row) => ({
                id: row.id,
                vector: JSON.parse(row.v_txt),
                dim: row.dim,
            }));
        } else {
            const rows = await this.db.all_async(
                `select id,v,dim from ${this.table} where sector=$1 and user_id=$2`,
                [sector, user_id],
            );
            return rows.map((row) => ({
                id: row.id,
                vector: bufferToVector(row.v),
                dim: row.dim,
            }));
        }
    }
}
