import { env } from "./config";
import { VectorStore } from "./vector_store";
import { PostgresVectorStore } from "./vector/postgres";
import { ValkeyVectorStore } from "./vector/valkey";
import {
    assertSafeIdentifier,
    DbInitError,
    DEFAULT_VECTOR_TABLE,
} from "./identifiers";
import { createClient, InStatement } from "@libsql/client";
import { encrypt, decrypt } from "./crypto";

const LEGACY_SQLITE_VECTOR_TABLE = "vectors";

// Re-export for downstream consumers (e.g. migrate.ts).
export { DEFAULT_VECTOR_TABLE };

type q_type = {
    ins_mem: { run: (...p: any[]) => Promise<void> };
    upd_mean_vec: { run: (...p: any[]) => Promise<void> };
    upd_compressed_vec: { run: (...p: any[]) => Promise<void> };
    upd_feedback: { run: (...p: any[]) => Promise<void> };
    upd_seen: { run: (...p: any[]) => Promise<void> };
    upd_mem: { run: (...p: any[]) => Promise<void> };
    upd_mem_with_sector: { run: (...p: any[]) => Promise<void> };
    del_mem: { run: (...p: any[]) => Promise<void> };
    get_mem: { get: (id: string) => Promise<any> };
    get_mem_by_simhash: { get: (simhash: string) => Promise<any> };
    all_mem: { all: (limit: number, offset: number) => Promise<any[]> };
    all_mem_by_sector: {
        all: (sector: string, limit: number, offset: number) => Promise<any[]>;
    };
    all_mem_by_user: {
        all: (user_id: string, limit: number, offset: number) => Promise<any[]>;
    };
    get_segment_count: {
        get: (
            segment: number,
            user_id?: string,
            project_id?: string,
        ) => Promise<any>;
    };
    get_max_segment: {
        get: (
            user_id?: string,
            project_id?: string,
            is_system?: boolean,
        ) => Promise<any>;
    };
    get_segments: {
        all: (
            user_id?: string,
            project_id?: string,
            is_system?: boolean,
        ) => Promise<any[]>;
    };
    get_mem_by_segment: {
        all: (
            segment: number,
            user_id?: string,
            project_id?: string,
            is_system?: boolean,
        ) => Promise<any[]>;
    };

    ins_waypoint: { run: (...p: any[]) => Promise<void> };
    get_neighbors: { all: (src: string) => Promise<any[]> };
    get_waypoints_by_src: { all: (src: string) => Promise<any[]> };
    get_waypoint: { get: (src: string, dst: string) => Promise<any> };
    upd_waypoint: { run: (...p: any[]) => Promise<void> };
    del_waypoints: { run: (...p: any[]) => Promise<void> };
    prune_waypoints: { run: (t: number) => Promise<void> };

    ins_log: { run: (...p: any[]) => Promise<void> };
    upd_log: { run: (...p: any[]) => Promise<void> };
    get_pending_logs: { all: () => Promise<any[]> };
    get_failed_logs: { all: () => Promise<any[]> };

    ins_user: { run: (...p: any[]) => Promise<void> };
    get_user: { get: (user_id: string) => Promise<any> };
    upd_user_summary: { run: (...p: any[]) => Promise<void> };

    clear_all: { run: () => Promise<void> };
};

const explicit_vector_table = process.env.OM_VECTOR_TABLE;
const sqlite_vector_table = assertSafeIdentifier(
    explicit_vector_table || DEFAULT_VECTOR_TABLE,
    "OM_VECTOR_TABLE",
);

const url =
    env.OM_TURSO_URL || `file:${env.db_path || "./data/openmemory.sqlite"}`;
const token = env.OM_TURSO_TOKEN;

/**
 * Singleton database client using libSQL.
 */
export const client = (() => {
    try {
        return createClient({ url, authToken: token });
    } catch (e: any) {
        throw new DbInitError(
            `Failed to initialize libSQL client: ${e.message}. URL: ${url}`,
        );
    }
})();

const mapRow = (row: any) => {
    if (!row) return row;
    const result = { ...row };
    if (result.content) {
        result.content = decrypt(result.content);
    }
    if (result.meta) {
        result.meta = decrypt(result.meta);
    }
    if (result.summary) {
        result.summary = decrypt(result.summary);
    }
    if (result.object) {
        result.object = decrypt(result.object);
    }
    if (result.metadata) {
        result.metadata = decrypt(result.metadata);
    }
    return result;
};

const mapRows = (rows: any[]) => rows.map(mapRow);

let txStmts: InStatement[] | null = null;

/**
 * Executes a SQL query directly against the client without buffering.
 */
const _exec_direct = async (sql: string, args: any[] = []) => {
    return await client.execute({ sql, args });
};

/**
 * Internal executor that respects transaction buffering.
 */
const exec = async (sql: string, args: any[] = []) => {
    if (txStmts) {
        txStmts.push({ sql, args });
        return;
    }
    await _exec_direct(sql, args);
};

export const run_async = exec;
export const run_async_direct = async (sql: string, args: any[] = []) => {
    await _exec_direct(sql, args);
};

export const get_async = async (sql: string, args: any[] = []) => {
    const result = await _exec_direct(sql, args);
    if (result.rows.length === 0) return undefined;
    return mapRow(result.rows[0]);
};

export const get_async_direct = get_async;

export const all_async = async (sql: string, args: any[] = []) => {
    if (txStmts) {
        txStmts.push({ sql, args });
        return [];
    }
    const result = await _exec_direct(sql, args);
    return mapRows(result.rows);
};

export const all_async_direct = async (sql: string, args: any[] = []) => {
    const result = await _exec_direct(sql, args);
    return mapRows(result.rows);
};

export const transaction = {
    begin: async () => {
        if (txStmts) {
            throw new Error("Transaction already active");
        }
        txStmts = [];
    },
    commit: async () => {
        if (!txStmts) return;
        const stmts = txStmts;
        txStmts = null;
        await client.batch(stmts, "write");
    },
    rollback: async () => {
        txStmts = null;
    },
};

export const memories_table = "memories";

export const vector_store: VectorStore =
    env.vector_store === "valkey"
        ? new ValkeyVectorStore()
        : new PostgresVectorStore(
              { run_async, get_async, all_async },
              sqlite_vector_table,
              !!env.OM_POSTGRES_URL,
          );

async function performWaypointsMigration(): Promise<void> {
    // Create new table with corrected schema
    await _exec_direct(`
        create table waypoints_new(
            src_id text,
            dst_id text not null,
            user_id text,
            project_id text,
            weight real not null,
            created_at integer,
            updated_at integer,
            primary key(src_id,dst_id,user_id)
        )
    `);

    // Backfill compatible waypoint relations from old table
    await _exec_direct(`
        insert into waypoints_new(src_id,dst_id,user_id,project_id,weight,created_at,updated_at)
        select src_id,dst_id,user_id,project_id,weight,created_at,updated_at from waypoints
        where dst_id is not null
    `);

    // Rename old table to backup
    await _exec_direct("alter table waypoints rename to waypoints_backup");

    // Rename new table to waypoints
    try {
        await _exec_direct(
            "alter table waypoints_new rename to waypoints",
        );
        // Rename succeeded, drop backup
        await _exec_direct("drop table waypoints_backup");
    } catch (renameError) {
        // Succeeded rename failed, restore backup from waypoints_backup
        try {
            await _exec_direct("alter table waypoints_backup rename to waypoints");
        } catch {}
        throw renameError;
    }
}

async function handleMigrationFailure(migrationError: any): Promise<void> {
    console.error(
        "[DB] Waypoints migration failed:",
        migrationError.message,
    );
    // Attempt cleanup and preserve/restore backup instead of unconditionally dropping waypoints_new
    try {
        const tables = await all_async_direct("select name from sqlite_master where type='table'");
        const tableNames = new Set(tables.map(t => t.name));

        if (tableNames.has("waypoints_backup") && !tableNames.has("waypoints")) {
            await _exec_direct("alter table waypoints_backup rename to waypoints");
        }
        if (tableNames.has("waypoints_new")) {
            await _exec_direct("drop table if exists waypoints_new");
        }
    } catch (cleanupError) {
        // Cleanup failed, but log original error
    }
    throw new DbInitError(
        `Waypoints migration failed: ${migrationError.message}`,
    );
}

async function migrateWaypointsTable(): Promise<void> {
    try {
        const info = await all_async_direct("PRAGMA table_info(waypoints)");
        if (!info || info.length === 0) return;

        const pkCols = info.filter((c) => c.pk > 0);
        const has_dst_id_pk = pkCols.some((c) => c.name === "dst_id");
        if (has_dst_id_pk) return;

        console.warn(
            "[DB] Migrating waypoints table to new schema with preserved data...",
        );
        try {
            await performWaypointsMigration();
            console.log(
                "[DB] Waypoints migration completed successfully",
            );
        } catch (migrationError: any) {
            await handleMigrationFailure(migrationError);
        }
    } catch (e: any) {
        if (e instanceof DbInitError) {
            throw e;
        }
        console.error("[DB] Unexpected error during waypoints migration check:", e);
        throw e;
    }
}

export const init_db = async () => {
    // Migration check for waypoints table primary key change
    await migrateWaypointsTable();

    const SCHEMA_TABLES = [
        "create table if not exists memories(id text primary key,user_id text,project_id text,segment integer default 0,content text not null,summary text,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0,coactivations integer default 0)",
        "create index if not exists idx_mem_user_id on memories(user_id)",
        "create index if not exists idx_mem_simhash on memories(simhash)",
        "create table if not exists openmemory_vectors(id text not null,project_id text,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))",
        "create index if not exists idx_vectors_user_id on openmemory_vectors(user_id)",
        "create index if not exists idx_vectors_sector on openmemory_vectors(sector)",
        "create table if not exists waypoints(src_id text,dst_id text not null,user_id text,project_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,dst_id,user_id))",
        "create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)",
        "create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)",
        "create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)",
        "create table if not exists temporal_facts(id text primary key,user_id text,project_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))",
        "create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))",
    ];
    for (const sql of SCHEMA_TABLES) {
        await exec(sql);
    }
};

export const q: q_type = {
    ins_mem: {
        run: (...p) => {
            const encryptedP = [...p];
            if (encryptedP[4] !== undefined && encryptedP[4] !== null) {
                encryptedP[4] = encrypt(encryptedP[4]);
            }
            if (encryptedP[8] !== undefined && encryptedP[8] !== null) {
                encryptedP[8] = encrypt(encryptedP[8]);
            }
            return exec(
                "insert into memories(id,user_id,project_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set user_id=excluded.user_id, project_id=excluded.project_id, content=excluded.content, simhash=excluded.simhash, primary_sector=excluded.primary_sector, tags=excluded.tags, meta=excluded.meta, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at, salience=excluded.salience, decay_lambda=excluded.decay_lambda, version=excluded.version, mean_dim=excluded.mean_dim, mean_vec=excluded.mean_vec, compressed_vec=excluded.compressed_vec, feedback_score=excluded.feedback_score",
                encryptedP,
            );
        },
    },
    upd_mean_vec: {
        run: (...p) =>
            exec("update memories set mean_dim=?,mean_vec=? where id=?", p),
    },
    upd_compressed_vec: {
        run: (...p) =>
            exec("update memories set compressed_vec=? where id=?", p),
    },
    upd_feedback: {
        run: (...p) =>
            exec(
                "update memories set feedback_score=?,coactivations=coactivations+1,updated_at=? where id=?",
                p,
            ),
    },
    upd_seen: {
        run: (...p) =>
            exec(
                "update memories set last_seen_at=?,salience=?,updated_at=? where id=?",
                p,
            ),
    },
    upd_mem: {
        run: (...p) => {
            const encryptedP = [...p];
            if (encryptedP[0] !== undefined && encryptedP[0] !== null) {
                encryptedP[0] = encrypt(encryptedP[0]);
            }
            if (encryptedP[2] !== undefined && encryptedP[2] !== null) {
                encryptedP[2] = encrypt(encryptedP[2]);
            }
            return exec(
                "update memories set content=?,tags=?,meta=?,updated_at=?,version=version+1 where id=?",
                encryptedP,
            );
        },
    },
    upd_mem_with_sector: {
        run: (...p) => {
            const encryptedP = [...p];
            if (encryptedP[0] !== undefined && encryptedP[0] !== null) {
                encryptedP[0] = encrypt(encryptedP[0]);
            }
            if (encryptedP[3] !== undefined && encryptedP[3] !== null) {
                encryptedP[3] = encrypt(encryptedP[3]);
            }
            return exec(
                "update memories set content=?,primary_sector=?,tags=?,meta=?,updated_at=?,version=version+1 where id=?",
                encryptedP,
            );
        },
    },
    del_mem: {
        run: async (...p) => {
            const id = p[0];
            const user_id = p[1];
            const project_id = p[2];
            try {
                await transaction.begin();
                let sql = "delete from memories where id=?";
                const params: any[] = [id];
                if (user_id) {
                    sql += " and user_id=?";
                    params.push(user_id);
                }
                if (project_id) {
                    sql += " and project_id=?";
                    params.push(project_id);
                }
                await exec(sql, params);

                let factSql =
                    "delete from temporal_facts where json_extract(metadata, '$.source_memory') = ?";
                const factParams: any[] = [id];
                if (user_id) {
                    factSql += " and user_id=?";
                    factParams.push(user_id);
                }
                if (project_id) {
                    factSql += " and project_id=?";
                    factParams.push(project_id);
                }
                await exec(factSql, factParams);

                await transaction.commit();
            } catch (err) {
                await transaction.rollback();
                throw err;
            }
        },
    },
    get_mem: {
        get: (id) => get_async("select * from memories where id=?", [id]),
    },
    get_mem_by_simhash: {
        get: (simhash) =>
            get_async(
                "select * from memories where simhash=? order by salience desc limit 1",
                [simhash],
            ),
    },
    all_mem: {
        all: (limit, offset) =>
            all_async(
                "select * from memories order by created_at desc limit ? offset ?",
                [limit, offset],
            ),
    },
    all_mem_by_sector: {
        all: (sector, limit, offset) =>
            all_async(
                "select * from memories where primary_sector=? order by created_at desc limit ? offset ?",
                [sector, limit, offset],
            ),
    },
    get_segment_count: {
        get: (segment, user_id, project_id) => {
            let sql = "select count(*) as c from memories where segment=?";
            const params: any[] = [segment];
            if (user_id) {
                sql += " and user_id=?";
                params.push(user_id);
            }
            if (project_id) {
                sql += " and project_id=?";
                params.push(project_id);
            }
            return get_async(sql, params);
        },
    },
    get_max_segment: {
        get: (user_id?: string, project_id?: string, is_system?: boolean) => {
            let sql =
                "select coalesce(max(segment), 0) as max_seg from memories where 1=1";
            const params: any[] = [];
            if (!is_system) {
                if (user_id) {
                    sql += " and user_id=?";
                    params.push(user_id);
                }
                if (project_id) {
                    sql += " and project_id=?";
                    params.push(project_id);
                }
            }
            return get_async(sql, params);
        },
    },
    get_segments: {
        all: (user_id?: string, project_id?: string, is_system?: boolean) => {
            let sql = "select distinct segment from memories where 1=1";
            const params: any[] = [];
            if (!is_system) {
                if (user_id) {
                    sql += " and user_id=?";
                    params.push(user_id);
                }
                if (project_id) {
                    sql += " and project_id=?";
                    params.push(project_id);
                }
            }
            sql += " order by segment desc";
            return all_async(sql, params);
        },
    },
    get_mem_by_segment: {
        all: (
            segment: number,
            user_id?: string,
            project_id?: string,
            is_system?: boolean,
        ) => {
            let sql = "select * from memories where segment=?";
            const params: any[] = [segment];
            if (!is_system) {
                if (user_id) {
                    sql += " and user_id=?";
                    params.push(user_id);
                }
                if (project_id) {
                    sql += " and project_id=?";
                    params.push(project_id);
                }
            }
            sql += " order by created_at desc";
            return all_async(sql, params);
        },
    },

    ins_waypoint: {
        run: (...p) =>
            exec(
                "insert into waypoints(src_id,dst_id,user_id,project_id,weight,created_at,updated_at) values(?,?,?,?,?,?,?) on conflict(src_id, dst_id, user_id) do update set dst_id=excluded.dst_id,project_id=excluded.project_id, weight=excluded.weight, created_at=excluded.created_at, updated_at=excluded.updated_at",
                p,
            ),
    },
    get_neighbors: {
        all: (src) =>
            all_async(
                "select dst_id,weight from waypoints where src_id=? order by weight desc",
                [src],
            ),
    },
    get_waypoints_by_src: {
        all: (src) =>
            all_async(
                "select src_id,dst_id,weight,created_at,updated_at from waypoints where src_id=?",
                [src],
            ),
    },
    get_waypoint: {
        get: (src, dst) =>
            get_async(
                "select weight from waypoints where src_id=? and dst_id=?",
                [src, dst],
            ),
    },
    upd_waypoint: {
        run: (...p) =>
            exec(
                "update waypoints set weight=?,updated_at=? where src_id=? and dst_id=?",
                p,
            ),
    },
    del_waypoints: {
        run: (...p) =>
            exec("delete from waypoints where src_id=? or dst_id=?", p),
    },
    prune_waypoints: {
        run: (t) => exec("delete from waypoints where weight<?", [t]),
    },
    ins_log: {
        run: (...p) =>
            exec(
                "insert into embed_logs(id,model,status,ts,err) values(?,?,?,?,?) on conflict (id) do update set model=excluded.model, status=excluded.status, ts=excluded.ts, err=excluded.err",
                p,
            ),
    },
    upd_log: {
        run: (...p) =>
            exec("update embed_logs set status=?,err=? where id=?", p),
    },
    get_pending_logs: {
        all: () =>
            all_async("select * from embed_logs where status=?", ["pending"]),
    },
    get_failed_logs: {
        all: () =>
            all_async(
                "select * from embed_logs where status=? order by ts desc limit 100",
                ["failed"],
            ),
    },
    all_mem_by_user: {
        all: (user_id, limit, offset) =>
            all_async(
                "select * from memories where user_id=? order by created_at desc limit ? offset ?",
                [user_id, limit, offset],
            ),
    },
    ins_user: {
        run: (...p) =>
            exec(
                "insert into users(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?) on conflict(user_id) do update set summary=excluded.summary,reflection_count=excluded.reflection_count,updated_at=excluded.updated_at",
                p,
            ),
    },
    get_user: {
        get: (user_id) =>
            get_async("select * from users where user_id=?", [user_id]),
    },
    upd_user_summary: {
        run: (...p) =>
            exec(
                "update users set summary=?,reflection_count=reflection_count+1,updated_at=? where user_id=?",
                p,
            ),
    },
    clear_all: {
        run: async () => {
            await exec("delete from memories");
            await exec("delete from waypoints");
            await exec("delete from users");
            await exec(`delete from ${sqlite_vector_table}`);
        },
    },
};

export const log_maint_op = async (
    type: "decay" | "reflect" | "consolidate",
    cnt = 1,
) => {
    try {
        const sql = "insert into stats(type,count,ts) values(?,?,?)";
        await run_async(sql, [type, cnt, Date.now()]);
    } catch (e) {
        console.error("[DB] Maintenance log error:", e);
    }
};
