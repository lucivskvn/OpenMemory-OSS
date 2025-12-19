import { Database } from "bun:sqlite";
import { SQL, sql } from "bun";
import { env } from "./cfg";
import path from "node:path";
import fs from "node:fs";
import { VectorStore } from "./vector_store";
import { PostgresVectorStore } from "./vector/postgres";
import { ValkeyVectorStore } from "./vector/valkey";
import { run_migrations_core } from "./migrations";

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
    ins_user: { run: (...p: any[]) => Promise<void> };
    get_user: { get: (user_id: string) => Promise<any> };
    upd_user_summary: { run: (...p: any[]) => Promise<void> };
};

let run_async: (sql: string, p?: any[]) => Promise<void>;
let get_async: (sql: string, p?: any[]) => Promise<any>;
let all_async: (sql: string, p?: any[]) => Promise<any[]>;
let transaction: {
    begin: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
};
let q: q_type;
let vector_store: VectorStore;
let memories_table: string;
let dbReadyPromise: Promise<void>;

const is_pg = env.metadata_backend === "postgres";

function convertPlaceholders(sql: string): string {
    if (!is_pg) return sql;
    let index = 1;
    return sql.replace(/\?/g, () => `$${index++}`);
}

export const init_db = async () => {
    // Await the global initialization promise to ensure migrations are done.
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
                    console.log(`[DB] Created ${db_name}`);
                } catch (e: any) {
                    if (e.code !== "42P04") {
                        console.warn("[DB] Create DB warning:", e);
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

    const sc = process.env.OM_PG_SCHEMA || "public";
    memories_table = `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"`;
    const v = `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`;

    const exec = async (query: string, p: any[] = []) => {
        return await pg.unsafe(convertPlaceholders(query), p);
    };

    let txClient: any = null;

    transaction = {
        begin: async () => {
            if (txClient) throw new Error("Transaction already active");
            txClient = await (pg as any).reserve();
            await txClient.unsafe("BEGIN");
        },
        commit: async () => {
            if (!txClient) return;
            try {
                await txClient.unsafe("COMMIT");
            } finally {
                txClient.release();
                txClient = null;
            }
        },
        rollback: async () => {
             if (!txClient) return;
            try {
                await txClient.unsafe("ROLLBACK");
            } finally {
                txClient.release();
                txClient = null;
            }
        }
    };

    const internal_init = async () => {
        await ensureDb();

        await run_migrations_core({
            run_async: async (s, p) => { await exec(s, p); },
            get_async: async (s, p) => (await exec(s, p))[0],
            all_async: async (s, p) => await exec(s, p),
            is_pg: true
        });

        if (env.vector_backend === "valkey") {
            vector_store = new ValkeyVectorStore();
            console.log("[DB] Using Valkey VectorStore");
        } else {
            vector_store = new PostgresVectorStore({ run_async, get_async, all_async }, v.replace(/"/g, ""));
            console.log(`[DB] Using Postgres VectorStore with table: ${v}`);
        }
    };

    dbReadyPromise = internal_init().catch(e => {
        console.error("[DB] Init failed:", e);
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

    memories_table = "memories";

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
            console.log("[DB] Using Valkey VectorStore");
        } else {
            vector_store = new PostgresVectorStore({ run_async, get_async, all_async }, sqlite_vector_table);
            console.log(`[DB] Using SQLite VectorStore with table: ${sqlite_vector_table}`);
        }
    };

    dbReadyPromise = internal_init().catch(e => {
        console.error("[DB] SQLite Init failed:", e);
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

    transaction = {
        begin: async () => {
            db.run("BEGIN TRANSACTION");
        },
        commit: async () => {
            db.run("COMMIT");
        },
        rollback: async () => {
            db.run("ROLLBACK");
        }
    };
}

q = {
    ins_mem: {
        run: (...p) =>
            run_async(
                `insert into ${memories_table}(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set user_id=excluded.user_id,segment=excluded.segment,content=excluded.content,simhash=excluded.simhash,primary_sector=excluded.primary_sector,tags=excluded.tags,meta=excluded.meta,created_at=excluded.created_at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience,decay_lambda=excluded.decay_lambda,version=excluded.version,mean_dim=excluded.mean_dim,mean_vec=excluded.mean_vec,compressed_vec=excluded.compressed_vec,feedback_score=excluded.feedback_score`,
                p,
            ),
    },
    upd_mean_vec: {
        run: (...p) =>
            run_async(
                `update ${memories_table} set mean_dim=?,mean_vec=? where id=?`,
                p,
            ),
    },
    upd_compressed_vec: {
        run: (...p) =>
            run_async(`update ${memories_table} set compressed_vec=? where id=?`, p),
    },
    upd_feedback: {
        run: (...p) =>
            run_async(`update ${memories_table} set feedback_score=? where id=?`, p),
    },
    upd_seen: {
        run: (...p) =>
            run_async(
                `update ${memories_table} set last_seen_at=?,salience=?,updated_at=? where id=?`,
                p,
            ),
    },
    upd_mem: {
        run: (...p) =>
            run_async(
                `update ${memories_table} set content=?,tags=?,meta=?,updated_at=?,version=version+1 where id=?`,
                p,
            ),
    },
    upd_mem_with_sector: {
        run: (...p) =>
            run_async(
                `update ${memories_table} set content=?,primary_sector=?,tags=?,meta=?,updated_at=?,version=version+1 where id=?`,
                p,
            ),
    },
    del_mem: {
        run: (...p) => run_async(`delete from ${memories_table} where id=?`, p),
    },
    get_mem: {
        get: (id) => get_async(`select * from ${memories_table} where id=?`, [id]),
    },
    get_mem_by_simhash: {
        get: (simhash) =>
            get_async(
                `select * from ${memories_table} where simhash=? order by salience desc limit 1`,
                [simhash],
            ),
    },
    all_mem: {
        all: (limit, offset) =>
            all_async(
                `select * from ${memories_table} order by created_at desc limit ? offset ?`,
                [limit, offset],
            ),
    },
    all_mem_by_sector: {
        all: (sector, limit, offset) =>
            all_async(
                `select * from ${memories_table} where primary_sector=? order by created_at desc limit ? offset ?`,
                [sector, limit, offset],
            ),
    },
    get_segment_count: {
        get: (segment) =>
            get_async(`select count(*) as c from ${memories_table} where segment=?`, [
                segment,
            ]),
    },
    get_max_segment: {
        get: () =>
            get_async(
                `select coalesce(max(segment), 0) as max_seg from ${memories_table}`,
                [],
            ),
    },
    get_segments: {
        all: () =>
            all_async(
                `select distinct segment from ${memories_table} order by segment desc`,
                [],
            ),
    },
    get_mem_by_segment: {
        all: (segment) =>
            all_async(
                `select * from ${memories_table} where segment=? order by created_at desc`,
                [segment],
            ),
    },
    ins_waypoint: {
        run: (...p) => {
            const w = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_waypoints"` : "waypoints";
            const sql = is_pg
                 ? `insert into ${w}(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?) on conflict(src_id,user_id) do update set dst_id=excluded.dst_id,weight=excluded.weight,updated_at=excluded.updated_at`
                 : `insert or replace into waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?)`;
            return run_async(sql, p);
        },
    },
    get_neighbors: {
        all: (src) => {
            const w = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_waypoints"` : "waypoints";
            return all_async(
                `select dst_id,weight from ${w} where src_id=? order by weight desc`,
                [src],
            );
        }
    },
    get_waypoints_by_src: {
        all: (src) => {
             const w = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_waypoints"` : "waypoints";
            return all_async(
                `select src_id,dst_id,weight,created_at,updated_at from ${w} where src_id=?`,
                [src],
            );
        }
    },
    get_waypoint: {
        get: (src, dst) => {
             const w = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_waypoints"` : "waypoints";
            return get_async(
                `select weight from ${w} where src_id=? and dst_id=?`,
                [src, dst],
            );
        }
    },
    upd_waypoint: {
        run: (...p) => {
             const w = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_waypoints"` : "waypoints";
            return run_async(
                `update ${w} set weight=?,updated_at=? where src_id=? and dst_id=?`,
                p,
            );
        }
    },
    del_waypoints: {
        run: (...p) => {
             const w = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_waypoints"` : "waypoints";
            return run_async(`delete from ${w} where src_id=? or dst_id=?`, p);
        }
    },
    prune_waypoints: {
        run: (t) => {
             const w = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_waypoints"` : "waypoints";
            return run_async(`delete from ${w} where weight<?`, [t]);
        }
    },
    ins_log: {
        run: (...p) => {
            const l = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_embed_logs"` : "embed_logs";
             const sql = is_pg
                 ? `insert into ${l}(id,model,status,ts,err) values(?,?,?,?,?) on conflict(id) do update set model=excluded.model,status=excluded.status,ts=excluded.ts,err=excluded.err`
                 : `insert or replace into embed_logs(id,model,status,ts,err) values(?,?,?,?,?)`;
            return run_async(sql, p);
        },
    },
    upd_log: {
        run: (...p) => {
             const l = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_embed_logs"` : "embed_logs";
            return run_async(`update ${l} set status=?,err=? where id=?`, p);
        }
    },
    get_pending_logs: {
        all: () => {
             const l = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_embed_logs"` : "embed_logs";
            return all_async(`select * from ${l} where status=?`, ["pending"]);
        }
    },
    get_failed_logs: {
        all: () => {
             const l = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_embed_logs"` : "embed_logs";
            return all_async(
                `select * from ${l} where status=? order by ts desc limit 100`,
                ["failed"],
            );
        }
    },
    all_mem_by_user: {
        all: (user_id, limit, offset) =>
            all_async(
                `select * from ${memories_table} where user_id=? order by created_at desc limit ? offset ?`,
                [user_id, limit, offset],
            ),
    },
    ins_user: {
        run: (...p) => {
             const u = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_users"` : "users";
             const sql = is_pg
                ? `insert into ${u}(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?) on conflict(user_id) do update set summary=excluded.summary,reflection_count=excluded.reflection_count,updated_at=excluded.updated_at`
                : `insert or ignore into users(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?)`;
            return run_async(sql, p);
        },
    },
    get_user: {
        get: (user_id) => {
             const u = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_users"` : "users";
            return get_async(
                `select * from ${u} where user_id=?`,
                [user_id],
            );
        }
    },
    upd_user_summary: {
        run: (...p) => {
             const u = is_pg ? `"${process.env.OM_PG_SCHEMA || "public"}"."openmemory_users"` : "users";
            return run_async(
                `update ${u} set summary=?,reflection_count=reflection_count+1,updated_at=? where user_id=?`,
                p,
            );
        }
    },
};

export const log_maint_op = async (
    type: "decay" | "reflect" | "consolidate",
    cnt = 1,
) => {
    try {
        const sql = is_pg
            ? `insert into "${process.env.OM_PG_SCHEMA || "public"}"."stats"(type,count,ts) values(?,?,?)`
            : "insert into stats(type,count,ts) values(?,?,?)";
        await run_async(sql, [type, cnt, Date.now()]);
    } catch (e) {
        console.error("[DB] Maintenance log error:", e);
    }
};

export { q, transaction, all_async, get_async, run_async, memories_table, vector_store };
