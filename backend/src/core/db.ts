import { Database } from "bun:sqlite";
import { SQL, sql } from "bun";
import { env } from "./cfg";
import { log } from "./log";
import path from "node:path";
import fs from "node:fs";
import { VectorStore } from "./vector_store";
import { PostgresVectorStore } from "./vector/postgres";
import { ValkeyVectorStore } from "./vector/valkey";
import { run_migrations_core } from "./migrations";

/**
 * Repository interface for all database queries.
 * Provides type-safe access to common operations.
 */
type QueryRepository = {
    /** Insert or update a memory record */
    ins_mem: { run: (...p: any[]) => Promise<void> };
    upd_mean_vec: { run: (...p: any[]) => Promise<void> };
    upd_compressed_vec: { run: (...p: any[]) => Promise<void> };
    upd_feedback: { run: (...p: any[]) => Promise<void> };
    upd_seen: { run: (...p: any[]) => Promise<void> };
    upd_mem: { run: (...p: any[]) => Promise<void> };
    upd_mem_with_sector: { run: (...p: any[]) => Promise<void> };
    del_mem: { run: (...p: any[]) => Promise<void> };
    /** Get a single memory by ID */
    get_mem: { get: (id: string) => Promise<any> };
    /** Batch retrieval of memories by ID list */
    get_mems_by_ids: { all: (ids: string[]) => Promise<any[]> };
    get_mem_by_simhash: { get: (simhash: string) => Promise<any> };
    all_mem: { all: (limit: number, offset: number) => Promise<any[]> };
    all_mem_by_sector: {
        all: (sector: string, limit: number, offset: number) => Promise<any[]>;
    };
    all_mem_by_user: {
        all: (user_id: string, limit: number, offset: number) => Promise<any[]>;
    };
    get_segment_count: { get: (segment: number) => Promise<any> };
    get_max_segment: { get: () => Promise<any> };
    get_segments: { all: () => Promise<any[]> };
    get_mem_by_segment: { all: (segment: number) => Promise<any[]> };
    ins_waypoint: { run: (...p: any[]) => Promise<void> };
    get_neighbors: { all: (src: string) => Promise<any[]> };
    get_waypoints_by_src: { all: (src: string) => Promise<any[]> };
    get_waypoint: { get: (src: string, dst: string) => Promise<any> };
    upd_waypoint: { run: (...p: any[]) => Promise<void> };
    del_waypoints: { run: (...p: any[]) => Promise<void> };
    prune_waypoints: { run: (threshold: number) => Promise<void> };
    ins_log: { run: (...p: any[]) => Promise<void> };
    upd_log: { run: (...p: any[]) => Promise<void> };
    get_pending_logs: { all: () => Promise<any[]> };
    get_failed_logs: { all: () => Promise<any[]> };
    get_recent_logs: { all: (limit: number) => Promise<any[]> };
    ins_user: { run: (...p: any[]) => Promise<void> };
    get_user: { get: (user_id: string) => Promise<any> };
    get_all_user_ids: { all: () => Promise<any[]> };
    /** Aggregate system statistics for dashboard */
    get_system_stats: { get: () => Promise<any> };
    upd_user_summary: { run: (...p: any[]) => Promise<void> };
    // Temporal
    ins_fact: { run: (...p: any[]) => Promise<void> };
    get_facts: { all: (f: { subject?: string; predicate?: string; object?: string; valid_at?: number }) => Promise<any[]> };
    inv_fact: { run: (id: string, valid_to: number) => Promise<void> };
    ins_edge: { run: (...p: any[]) => Promise<void> };
    get_edges: { all: (source_id: string) => Promise<any[]> };
};

let run_async: (sql: string, p?: any[]) => Promise<void>;
let get_async: (sql: string, p?: any[]) => Promise<any>;
let all_async: (sql: string, p?: any[]) => Promise<any[]>;
let transaction: {
    begin: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
};
let q: QueryRepository;
let vector_store: VectorStore;
let memories_table: string;
let dbReadyPromise: Promise<void>;

const is_pg = env.metadata_backend === "postgres";
const sc = process.env.OM_PG_SCHEMA || "public";

// Constants for table names
export const TABLE_MEMORIES = is_pg ? `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"` : "memories";
export const TABLE_VECTORS = `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`;
export const TABLE_WAYPOINTS = is_pg ? `"${sc}"."openmemory_waypoints"` : "waypoints";
export const TABLE_LOGS = is_pg ? `"${sc}"."openmemory_embed_logs"` : "embed_logs";
export const TABLE_USERS = is_pg ? `"${sc}"."openmemory_users"` : "users";
export const TABLE_STATS = is_pg ? `"${sc}"."stats"` : "stats";
export const TABLE_TF = is_pg ? `"${sc}"."temporal_facts"` : "temporal_facts";
export const TABLE_TE = is_pg ? `"${sc}"."temporal_edges"` : "temporal_edges";


function convertPlaceholders(sql: string): string {
    if (!is_pg) return sql;
    let index = 1;
    return sql.replace(/\?/g, () => `$${index++}`);
}

export const init_db = async () => {
    if (dbReadyPromise) {
        await dbReadyPromise;
    }
};

if (is_pg) {
    const db_name = process.env.OM_PG_DB || "openmemory";
    const pgConfig = {
        hostname: process.env.OM_PG_HOST,
        port: process.env.OM_PG_PORT ? +process.env.OM_PG_PORT : 5432,
        database: db_name,
        username: process.env.OM_PG_USER,
        password: process.env.OM_PG_PASSWORD,
        ssl: process.env.OM_PG_SSL === "require" ? "require" : (process.env.OM_PG_SSL === "disable" ? "disable" : "prefer"),
    };

    let pg = new SQL(pgConfig as any);

    const ensureDb = async () => {
        try {
            await pg`SELECT 1`;
        } catch (err: any) {
             if (err && (err.code === "3D000" || err.message?.includes("does not exist"))) {
                const adminConfig = { ...pgConfig, database: "postgres" };
                const admin = new SQL(adminConfig as any);
                try {
                    await admin`CREATE DATABASE ${sql(db_name)}`;
                    log.info(`[DB] Created ${db_name}`);
                } catch (e: any) {
                    if (e.code !== "42P04") {
                        log.warn("[DB] Create DB warning:", { error: e });
                    }
                } finally {
                    await admin.close();
                }
                await pg.close();
                pg = new SQL(pgConfig as any);
             } else {
                 throw err;
             }
        }
    };

    const exec = async (query: string, p: any[] = []) => {
        return await pg.unsafe(convertPlaceholders(query), p);
    };

    let txClient: any = null;
    let txDepth = 0;

    transaction = {
        begin: async () => {
            if (txClient) {
                txDepth++;
                return;
            }
            txClient = await (pg as any).reserve();
            await txClient.unsafe("BEGIN");
            txDepth = 1;
        },
        commit: async () => {
            if (!txClient) return;
            txDepth--;
            if (txDepth > 0) return;
            try {
                await txClient.unsafe("COMMIT");
            } finally {
                txClient.release();
                txClient = null;
                txDepth = 0;
            }
        },
        rollback: async () => {
             if (!txClient) return;
            try {
                await txClient.unsafe("ROLLBACK");
            } finally {
                txClient.release();
                txClient = null;
                txDepth = 0;
            }
        }
    };

    const internal_init = async () => {
        await ensureDb();

        // Ensure pgvector extension
        await pg`CREATE EXTENSION IF NOT EXISTS vector`;

        await run_migrations_core({
            run_async: async (s, p) => { await exec(s, p); },
            get_async: async (s, p) => (await exec(s, p))[0],
            all_async: async (s, p) => await exec(s, p),
            is_pg: true
        });

        if (env.vector_backend === "valkey") {
            vector_store = new ValkeyVectorStore();
            log.info("[DB] Using Valkey VectorStore");
        } else {
            vector_store = new PostgresVectorStore({ run_async, get_async, all_async }, TABLE_VECTORS.replace(/"/g, ""));
            log.info(`[DB] Using Postgres VectorStore with table: ${TABLE_VECTORS}`);
        }
    };

    dbReadyPromise = internal_init().catch(e => {
        log.error("[DB] Init failed:", { error: e });
        process.exit(1);
    });

    const safe_exec = async (s: string, p: any[]) => {
        await dbReadyPromise;
        const c = txClient || pg;
        return c.unsafe(convertPlaceholders(s), p);
    };

    run_async = async (s, p = []) => { await safe_exec(s, p); };
    get_async = async (s, p = []) => (await safe_exec(s, p))[0];
    all_async = async (s, p = []) => await safe_exec(s, p);

} else {
    // SQLite
    const db_path =
        env.db_path ||
        path.resolve(process.cwd(), "data/openmemory.sqlite");
    const dir = path.dirname(db_path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = new Database(db_path);
    const sqlite_vector_table = process.env.OM_VECTOR_TABLE || "vectors";

    // Config
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=NORMAL");
    db.run("PRAGMA temp_store=MEMORY");
    db.run("PRAGMA cache_size=-8000");
    db.run("PRAGMA mmap_size=134217728");
    db.run("PRAGMA foreign_keys=OFF");
    db.run("PRAGMA wal_autocheckpoint=20000");
    db.run("PRAGMA locking_mode=NORMAL");
    db.run("PRAGMA busy_timeout=5000");

    // Raw execution wrapper for migrations
    const exec = async (sql: string, p: any[] = []) => {
        return new Promise<void>((resolve, reject) => {
            try {
                db.run(sql, p);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    };

    // Internal Init Logic
    const internal_init = async () => {
         await run_migrations_core({
             run_async: exec,
             get_async: async (s, p) => db.query(s).get(p as any) as any,
             all_async: async (s, p) => db.query(s).all(p as any) as any[],
             is_pg: false
         });

         if (env.vector_backend === "valkey") {
            vector_store = new ValkeyVectorStore();
            log.info("[DB] Using Valkey VectorStore");
        } else {
            vector_store = new PostgresVectorStore({ run_async, get_async, all_async }, sqlite_vector_table);
            log.info(`[DB] Using SQLite VectorStore with table: ${sqlite_vector_table}`);
        }
    };

    dbReadyPromise = internal_init().catch(e => {
        log.error("[DB] SQLite Init failed:", { error: e });
        process.exit(1);
    });

    const safe_exec = async (fn: () => any) => {
        await dbReadyPromise;
        return fn();
    };

    run_async = async (sql: string, p: any[] = []) => {
        await dbReadyPromise;
        db.run(sql, p);
    };
    get_async = async (sql: string, p: any[] = []) => {
        await dbReadyPromise;
        return db.query(sql).get(p as any) as any;
    };
    all_async = async (sql: string, p: any[] = []) => {
        await dbReadyPromise;
        return db.query(sql).all(p as any) as any[];
    };

    let txDepth = 0;
    transaction = {
        begin: async () => {
            if (txDepth === 0) {
                db.run("BEGIN TRANSACTION");
            }
            txDepth++;
        },
        commit: async () => {
            if (txDepth > 0) txDepth--;
            if (txDepth === 0) {
                db.run("COMMIT");
            }
        },
        rollback: async () => {
            db.run("ROLLBACK");
            txDepth = 0;
        }
    };
}

// Helpers for SQL generation
const gen_upsert = (table: string, keys: string[], on_conflict: string, update_cols: string[]) => {
    const vals = keys.map(() => "?").join(",");
    const updates = update_cols.map(c => `${c}=excluded.${c}`).join(",");
    return `insert into ${table}(${keys.join(",")}) values(${vals}) on conflict(${on_conflict}) do update set ${updates}`;
};
const gen_replace = (table: string, keys: string[]) => {
    const vals = keys.map(() => "?").join(",");
    return `insert or replace into ${table}(${keys.join(",")}) values(${vals})`;
};

q = {
    ins_mem: {
        run: (...p) =>
            run_async(
                `insert into ${TABLE_MEMORIES}(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set user_id=excluded.user_id,segment=excluded.segment,content=excluded.content,simhash=excluded.simhash,primary_sector=excluded.primary_sector,tags=excluded.tags,meta=excluded.meta,created_at=excluded.created_at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience,decay_lambda=excluded.decay_lambda,version=excluded.version,mean_dim=excluded.mean_dim,mean_vec=excluded.mean_vec,compressed_vec=excluded.compressed_vec,feedback_score=excluded.feedback_score`,
                p,
            ),
    },
    upd_mean_vec: {
        run: (...p) =>
            run_async(
                `update ${TABLE_MEMORIES} set mean_dim=?,mean_vec=? where id=?`,
                p,
            ),
    },
    upd_compressed_vec: {
        run: (...p) =>
            run_async(`update ${TABLE_MEMORIES} set compressed_vec=? where id=?`, p),
    },
    upd_feedback: {
        run: (...p) =>
            run_async(`update ${TABLE_MEMORIES} set feedback_score=? where id=?`, p),
    },
    upd_seen: {
        run: (...p) =>
            run_async(
                `update ${TABLE_MEMORIES} set last_seen_at=?,salience=?,updated_at=? where id=?`,
                p,
            ),
    },
    upd_mem: {
        run: (...p) =>
            run_async(
                `update ${TABLE_MEMORIES} set content=?,tags=?,meta=?,updated_at=?,version=version+1 where id=?`,
                p,
            ),
    },
    upd_mem_with_sector: {
        run: (...p) =>
            run_async(
                `update ${TABLE_MEMORIES} set content=?,primary_sector=?,tags=?,meta=?,updated_at=?,version=version+1 where id=?`,
                p,
            ),
    },
    del_mem: {
        run: (...p) => run_async(`delete from ${TABLE_MEMORIES} where id=?`, p),
    },
    get_mem: {
        get: (id) => get_async(`select * from ${TABLE_MEMORIES} where id=?`, [id]),
    },
    get_mems_by_ids: {
        all: async (ids: string[]) => {
            if (ids.length === 0) return [];
            const placeholders = ids.map(() => "?").join(",");
            return all_async(`select * from ${TABLE_MEMORIES} where id in (${placeholders})`, ids);
        }
    },
    get_all_user_ids: {
        all: () => {
            return all_async(`select distinct user_id from ${TABLE_MEMORIES} where user_id is not null`, []);
        }
    },
    get_mem_by_simhash: {
        get: (simhash) =>
            get_async(
                `select * from ${TABLE_MEMORIES} where simhash=? order by salience desc limit 1`,
                [simhash],
            ),
    },
    all_mem: {
        all: (limit, offset) =>
            all_async(
                `select * from ${TABLE_MEMORIES} order by created_at desc limit ? offset ?`,
                [limit, offset],
            ),
    },
    all_mem_by_sector: {
        all: (sector, limit, offset) =>
            all_async(
                `select * from ${TABLE_MEMORIES} where primary_sector=? order by created_at desc limit ? offset ?`,
                [sector, limit, offset],
            ),
    },
    get_segment_count: {
        get: (segment) =>
            get_async(`select count(*) as c from ${TABLE_MEMORIES} where segment=?`, [
                segment,
            ]),
    },
    get_max_segment: {
        get: () =>
            get_async(
                `select coalesce(max(segment), 0) as max_seg from ${TABLE_MEMORIES}`,
                [],
            ),
    },
    get_segments: {
        all: () =>
            all_async(
                `select distinct segment from ${TABLE_MEMORIES} order by segment desc`,
                [],
            ),
    },
    get_mem_by_segment: {
        all: (segment) =>
            all_async(
                `select * from ${TABLE_MEMORIES} where segment=? order by created_at desc`,
                [segment],
            ),
    },
    ins_waypoint: {
        run: (...p) => {
            const cols = ["src_id", "dst_id", "user_id", "weight", "created_at", "updated_at"];
            const sql = is_pg
                 ? gen_upsert(TABLE_WAYPOINTS, cols, "src_id,user_id", ["dst_id", "weight", "updated_at"])
                 : gen_replace(TABLE_WAYPOINTS, cols);
            return run_async(sql, p);
        },
    },
    get_neighbors: {
        all: (src) => {
            return all_async(
                `select dst_id,weight from ${TABLE_WAYPOINTS} where src_id=? order by weight desc`,
                [src],
            );
        }
    },
    get_waypoints_by_src: {
        all: (src) => {
            return all_async(
                `select src_id,dst_id,weight,created_at,updated_at from ${TABLE_WAYPOINTS} where src_id=?`,
                [src],
            );
        }
    },
    get_waypoint: {
        get: (src, dst) => {
            return get_async(
                `select weight from ${TABLE_WAYPOINTS} where src_id=? and dst_id=?`,
                [src, dst],
            );
        }
    },
    upd_waypoint: {
        run: (...p) => {
            return run_async(
                `update ${TABLE_WAYPOINTS} set weight=?,updated_at=? where src_id=? and dst_id=?`,
                p,
            );
        }
    },
    del_waypoints: {
        run: (...p) => {
            return run_async(`delete from ${TABLE_WAYPOINTS} where src_id=? or dst_id=?`, p);
        }
    },
    prune_waypoints: {
        run: (t) => {
            return run_async(`delete from ${TABLE_WAYPOINTS} where weight<?`, [t]);
        }
    },
    ins_log: {
        run: (...p) => {
             const cols = ["id", "model", "status", "ts", "err"];
             const sql = is_pg
                 ? gen_upsert(TABLE_LOGS, cols, "id", ["model", "status", "ts", "err"])
                 : gen_replace(TABLE_LOGS, cols);
            return run_async(sql, p);
        },
    },
    upd_log: {
        run: (...p) => {
            return run_async(`update ${TABLE_LOGS} set status=?,err=? where id=?`, p);
        }
    },
    get_pending_logs: {
        all: () => {
            return all_async(`select * from ${TABLE_LOGS} where status=?`, ["pending"]);
        }
    },
    get_failed_logs: {
        all: () => {
            return all_async(
                `select * from ${TABLE_LOGS} where status=? order by ts desc limit 100`,
                ["failed"],
            );
        }
    },
    get_recent_logs: {
        all: (limit: number) => {
            return all_async(
                `select * from ${TABLE_LOGS} order by ts desc limit ?`,
                [limit],
            );
        }
    },
    all_mem_by_user: {
        all: (user_id, limit, offset) =>
            all_async(
                `select * from ${TABLE_MEMORIES} where user_id=? order by created_at desc limit ? offset ?`,
                [user_id, limit, offset],
            ),
    },
    ins_user: {
        run: (...p) => {
            const cols = ["user_id", "summary", "reflection_count", "created_at", "updated_at"];
             const sql = is_pg
                ? gen_upsert(TABLE_USERS, cols, "user_id", ["summary", "reflection_count", "updated_at"])
                : `insert or ignore into users(${cols.join(",")}) values(?,?,?,?,?)`;
            return run_async(sql, p);
        },
    },
    get_user: {
        get: (user_id) => {
            return get_async(
                `select * from ${TABLE_USERS} where user_id=?`,
                [user_id],
            );
        }
    },
    get_system_stats: {
        get: async () => {
            const [totalMemories, totalUsers, requestStats, maintenanceStats, maxSeg] = await Promise.all([
                get_async(`select count(*) as c from ${TABLE_MEMORIES}`),
                get_async(`select count(*) as c from ${TABLE_USERS}`),
                all_async(`select * from ${TABLE_STATS} where type='request' order by ts desc limit 60`),
                all_async(`select * from ${TABLE_STATS} where type in ('decay','reflect','consolidate') order by ts desc limit 50`),
                get_async(`select coalesce(max(segment), 0) as max_seg from ${TABLE_MEMORIES}`)
            ]);
            return { totalMemories, totalUsers, requestStats, maintenanceStats, activeSegments: maxSeg?.max_seg || 0 };
        }
    },
    upd_user_summary: {
        run: (...p) => {
            return run_async(
                `update ${TABLE_USERS} set summary=?,reflection_count=reflection_count+1,updated_at=? where user_id=?`,
                p,
            );
        }
    },
    ins_fact: {
        run: (...p) => {
            const cols = ["id", "subject", "predicate", "object", "valid_from", "valid_to", "confidence", "last_updated", "metadata"];
            const sql = is_pg
                ? gen_upsert(TABLE_TF, cols, "subject,predicate,object,valid_from", ["valid_to", "confidence", "last_updated", "metadata"])
                : gen_replace(TABLE_TF, cols);
            return run_async(sql, p);
        },
    },
    get_facts: {
        all: async (f) => {
            let sql = `select * from ${TABLE_TF} where 1=1`;
            const params = [];
            if (f.subject) { sql += ` and subject=?`; params.push(f.subject); }
            if (f.predicate) { sql += ` and predicate=?`; params.push(f.predicate); }
            if (f.object) { sql += ` and object=?`; params.push(f.object); }
            if (f.valid_at) {
                sql += ` and valid_from <= ? and (valid_to is null or valid_to >= ?)`;
                params.push(f.valid_at, f.valid_at);
            }
            sql += ` order by valid_from desc`;
            return all_async(sql, params);
        }
    },
    inv_fact: {
        run: (id, valid_to) => run_async(`update ${TABLE_TF} set valid_to=?, last_updated=? where id=?`, [valid_to, Date.now(), id]),
    },
    ins_edge: {
        run: (...p) => {
            const cols = ["id", "source_id", "target_id", "relation_type", "valid_from", "valid_to", "weight", "metadata"];
            const sql = is_pg
                ? gen_upsert(TABLE_TE, cols, "id", ["valid_to", "weight", "metadata"]) // TE id is primary key
                : gen_replace(TABLE_TE, cols);
            return run_async(sql, p);
        },
    },
    get_edges: {
        all: (source_id) => all_async(`select * from ${TABLE_TE} where source_id=?`, [source_id]),
    },
};

export const log_maint_op = async (
    type: "decay" | "reflect" | "consolidate",
    cnt = 1,
) => {
    try {
        await run_async(`insert into ${TABLE_STATS}(type,count,ts) values(?,?,?)`, [
            type,
            cnt,
            Date.now(),
        ]);
    } catch (e) {
        log.error("[DB] Maintenance log error:", { error: e });
    }
};

export { q, transaction, all_async, get_async, run_async, memories_table, vector_store };
