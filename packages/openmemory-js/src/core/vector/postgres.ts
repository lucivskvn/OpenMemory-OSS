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
        user_id?: string,
        project_id?: string,
    ): Promise<void> {
        if (this.usePgVector) {
            const v_str = JSON.stringify(vector);
            const sql = `insert into ${this.table}(id,sector,user_id,project_id,v,dim) values($1,$2,$3,$4,$5::vector,$6) on conflict(id,sector) do update set user_id=excluded.user_id,project_id=excluded.project_id,v=excluded.v,dim=excluded.dim`;
            await this.db.run_async(sql, [
                id,
                sector,
                user_id || "anonymous",
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
                user_id || "anonymous",
                project_id || null,
                v,
                dim,
            ]);
        }
    }

    async deleteVector(id: string, sector: string, user_id: string = "anonymous"): Promise<void> {
        const is_postgres = this.usePgVector || !!process.env.OM_POSTGRES_URL;
        const param = (i: number) => is_postgres ? `$${i}` : "?";
        const sql = `delete from ${this.table} where id=${param(1)} and sector=${param(2)} and user_id=${param(3)}`;
        const params: any[] = [id, sector, user_id];
        await this.db.run_async(sql, params);
    }

    async deleteVectors(
        id: string,
        user_id: string = "anonymous",
    ): Promise<void> {
        let sql = `delete from ${this.table} where id=$1 and user_id=$2`;
        const params: any[] = [id, user_id];
        await this.db.run_async(sql, params);
    }

    async searchSimilar(
        sector: string,
        queryVec: number[],
        topK: number,
        user_id: string = "anonymous",
        project_id?: string,
    ): Promise<Array<{ id: string; score: number }>> {
        if (this.usePgVector) {
            const v_str = JSON.stringify(queryVec);
            let filter_sql = "where sector = $2 and user_id = $4";
            const args: any[] = [v_str, sector, topK, user_id];

            if (project_id) {
                filter_sql +=
                    " and (project_id = $5 or project_id = 'system_global' or project_id IS NULL)";
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
            const is_postgres =
                this.usePgVector || !!process.env.OM_POSTGRES_URL;
            const param = (i: number) => (is_postgres ? `$${i}` : "?");

            const direct_args: any[] = [sector, user_id];
            let direct_filter = `where sector=${param(1)} and user_id=${param(2)}`;
            let idx = 3;

            if (project_id) {
                direct_filter += ` and (project_id=${param(idx++)} or project_id='system_global' or project_id IS NULL)`;
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
        user_id: string = "anonymous",
    ): Promise<{ vector: number[]; dim: number } | null> {
        let sql = `select v${this.usePgVector ? "::text" : ""} as v_val, dim from ${this.table} where id=$1 and sector=$2 and user_id=$3`;
        const params: any[] = [id, sector, user_id];

        const row = await this.db.get_async(sql, params);
        if (!row) return null;

        const vector = this.usePgVector
            ? JSON.parse(row.v_val)
            : bufferToVector(row.v_val);

        return { vector, dim: row.dim };
    }

    async getVectorsById(
        id: string,
        user_id: string = "anonymous",
    ): Promise<Array<{ sector: string; vector: number[]; dim: number }>> {
        let sql = `select sector, v${this.usePgVector ? "::text" : ""} as v_val, dim from ${this.table} where id=$1 and user_id=$2`;
        const params: any[] = [id, user_id];

        const rows = await this.db.all_async(sql, params);
        return rows.map((row) => ({
            sector: row.sector,
            vector: this.usePgVector
                ? JSON.parse(row.v_val)
                : bufferToVector(row.v_val),
            dim: row.dim,
        }));
    }

    async getVectorsBySector(
        sector: string,
        user_id: string = "anonymous",
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>> {
        let sql = `select id, v${this.usePgVector ? "::text" : ""} as v_val, dim from ${this.table} where sector=$1 and user_id=$2`;
        const params: any[] = [sector, user_id];

        const rows = await this.db.all_async(sql, params);
        return rows.map((row) => ({
            id: row.id,
            vector: this.usePgVector
                ? JSON.parse(row.v_val)
                : bufferToVector(row.v_val),
            dim: row.dim,
        }));
    }
}
