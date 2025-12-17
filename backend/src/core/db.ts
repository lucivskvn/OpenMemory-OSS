import { Database } from "bun:sqlite";
import { SQL, sql } from "bun";
import { env } from "./cfg";
import path from "node:path";
import fs from "node:fs";
import { VectorStore } from "./vector_store";
import { PostgresVectorStore } from "./vector/postgres";
import { ValkeyVectorStore } from "./vector/valkey";

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

const is_pg = env.metadata_backend === "postgres";

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, $3 placeholders
// Bun.sql (postgres) uses $1, $2 too or template literals.
// But we are passing raw strings to it? No, Bun.sql uses template literals for safety.
// However, the existing code uses pre-constructed SQL strings with placeholders.
// We need to adapt the execution function to handle this.
// For Bun.sql (Postgres), we can use `await sql.unsafe(query, params)`.
function convertPlaceholders(sql: string): string {
    if (!is_pg) return sql;
    let index = 1;
    return sql.replace(/\?/g, () => `$${index++}`);
}

if (is_pg) {
    const db_name = process.env.OM_PG_DB || "openmemory";
    // We assume DATABASE_URL or specific vars. Bun.sql auto-detects from env or we build URL.
    // If we have separate vars, we can construct the URL or pass config object if using `new SQL`.
    // But `bun` exports `sql` which is auto-configured.
    // If we need specific config, we use `new SQL({...})`.
    const pgConfig = {
        hostname: process.env.OM_PG_HOST,
        port: process.env.OM_PG_PORT ? +process.env.OM_PG_PORT : 5432,
        database: db_name,
        username: process.env.OM_PG_USER,
        password: process.env.OM_PG_PASSWORD,
        ssl: process.env.OM_PG_SSL === "require" ? "require" : (process.env.OM_PG_SSL === "disable" ? "disable" : "prefer"),
    };

    // Check if we need to create DB first?
    // Bun SQL might fail if DB doesn't exist.
    // We can try connecting to 'postgres' db first to create if needed.

    // For simplicity, let's assume the user handles DB creation or we try.
    // But we should stick to what previous code did: check and create.
    // We can use a temporary connection to 'postgres' database.

    let pg = new SQL(pgConfig as any);

    // But wait, if db doesn't exist, this might fail on first query.
    // Previous code: connected to `db_name`. If failed with 3D000, connected to postgres and created.

    const ensureDb = async () => {
        try {
            await pg`SELECT 1`;
        } catch (err: any) {
             // Postgres error code for "database does not exist" is 3D000
             // But Bun might expose it differently.
             // We can check error message or code property if available.
             if (err && (err.code === "3D000" || err.message?.includes("does not exist"))) {
                const adminConfig = { ...pgConfig, database: "postgres" };
                const admin = new SQL(adminConfig as any);
                try {
                    await admin`CREATE DATABASE ${sql(db_name)}`;
                    console.log(`[DB] Created ${db_name}`);
                } catch (e: any) {
                    if (e.code !== "42P04") { // duplicate_database
                        console.warn("[DB] Create DB warning:", e);
                    }
                } finally {
                    await admin.close();
                }
                // Reconnect
                await pg.close();
                pg = new SQL(pgConfig as any);
             } else {
                 throw err;
             }
        }
    };

    const sc = process.env.OM_PG_SCHEMA || "public";
    const m = `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"`;
    memories_table = m;
    const v = `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`;
    const w = `"${sc}"."openmemory_waypoints"`;
    const l = `"${sc}"."openmemory_embed_logs"`;
    // const f = `"${sc}"."openmemory_memories_fts"`;

    const exec = async (query: string, p: any[] = []) => {
        // Use unsafe because query string is dynamic/legacy
        return await pg.unsafe(convertPlaceholders(query), p);
    };

    run_async = async (s, p = []) => { await exec(s, p); };
    get_async = async (s, p = []) => {
        const res = await exec(s, p);
        return res[0];
    };
    all_async = async (s, p = []) => await exec(s, p);

    let txClient: any = null;

    transaction = {
        begin: async () => {
            // Bun SQL supports `await sql.begin(tx => ...)` but here we expose begin/commit/rollback manually.
            // This is tricky with Bun SQL's callback-based transaction API.
            // However, we can use `begin()` method on the instance if available?
            // Actually Bun SQL documentation says `await sql.begin(async tx => ...)`
            // It doesn't seem to expose a manual begin/commit without a scope.
            // BUT, standard SQL commands work if we have a reserved connection.
            // So we reserve a connection.
            if (txClient) throw new Error("Transaction already active");
            // reserve() is available on Bun SQL instance? Docs say yes.
            // "const reserved = await sql.reserve();"
            // Wait, I need to check if my version of Bun supports this. The docs said yes.
            // Assuming `pg` is the SQL instance.
            // Typescript might complain if types aren't updated.
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

    const init = async () => {
        await ensureDb();

        await pg.unsafe(`create table if not exists ${m}(id uuid primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at bigint,updated_at bigint,last_seen_at bigint,salience double precision,decay_lambda double precision,version integer default 1,mean_dim integer,mean_vec bytea,compressed_vec bytea,feedback_score double precision default 0)`);
        await pg.unsafe(`create table if not exists ${v}(id uuid,sector text,user_id text,v bytea,dim integer not null,primary key(id,sector))`);
        await pg.unsafe(`create table if not exists ${w}(src_id text,dst_id text not null,user_id text,weight double precision not null,created_at bigint,updated_at bigint,primary key(src_id,user_id))`);
        await pg.unsafe(`create table if not exists ${l}(id text primary key,model text,status text,ts bigint,err text)`);
        await pg.unsafe(`create table if not exists "${sc}"."openmemory_users"(user_id text primary key,summary text,reflection_count integer default 0,created_at bigint,updated_at bigint)`);
        await pg.unsafe(`create table if not exists "${sc}"."stats"(id serial primary key,type text not null,count integer default 1,ts bigint not null)`);

        await pg.unsafe(`create index if not exists openmemory_memories_sector_idx on ${m}(primary_sector)`);
        await pg.unsafe(`create index if not exists openmemory_memories_segment_idx on ${m}(segment)`);
        await pg.unsafe(`create index if not exists openmemory_memories_simhash_idx on ${m}(simhash)`);
        await pg.unsafe(`create index if not exists openmemory_memories_user_idx on ${m}(user_id)`);
        await pg.unsafe(`create index if not exists openmemory_vectors_user_idx on ${v}(user_id)`);
        await pg.unsafe(`create index if not exists openmemory_waypoints_user_idx on ${w}(user_id)`);
        await pg.unsafe(`create index if not exists openmemory_stats_ts_idx on "${sc}"."stats"(ts)`);
        await pg.unsafe(`create index if not exists openmemory_stats_type_idx on "${sc}"."stats"(type)`);

        // Initialize VectorStore
        if (env.vector_backend === "valkey") {
            vector_store = new ValkeyVectorStore();
            console.log("[DB] Using Valkey VectorStore");
        } else {
            // const vt = process.env.OM_VECTOR_TABLE || "openmemory_vectors";
            vector_store = new PostgresVectorStore({ run_async, get_async, all_async }, v.replace(/"/g, ""));
            console.log(`[DB] Using Postgres VectorStore with table: ${v}`);
        }
    };

    // We execute init but we need to wait for it before any query?
    // The previous code had a 'ready' flag and queue.
    // We can do the same or just await init at top level if Bun allows, or use a promise.
    const initPromise = init().catch(e => {
        console.error("[DB] Init failed:", e);
        process.exit(1);
    });

    const safe_exec = async (s: string, p: any[]) => {
        await initPromise;
        const c = txClient || pg;
        return c.unsafe(convertPlaceholders(s), p);
    };

    run_async = async (s, p = []) => { await safe_exec(s, p); };
    get_async = async (s, p = []) => (await safe_exec(s, p))[0];
    all_async = async (s, p = []) => await safe_exec(s, p);

} else {
    // SQLite with Bun:sqlite
    const db_path =
        env.db_path ||
        path.resolve(process.cwd(), "data/openmemory.sqlite"); // Bun uses process.cwd() usually
    const dir = path.dirname(db_path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = new Database(db_path);

    // SQLite vector table name from env
    const sqlite_vector_table = process.env.OM_VECTOR_TABLE || "vectors";

    // Config
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=NORMAL");
    db.run("PRAGMA temp_store=MEMORY");
    // cache_size is pages. -8000 means 8000KB? No, negative is KB. -8000 is ~8MB.
    db.run("PRAGMA cache_size=-8000");
    // mmap_size
    db.run("PRAGMA mmap_size=134217728");
    db.run("PRAGMA foreign_keys=OFF");
    db.run("PRAGMA wal_autocheckpoint=20000");
    db.run("PRAGMA locking_mode=NORMAL");
    db.run("PRAGMA busy_timeout=5000");

    db.run(`create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`);
    db.run(`create table if not exists ${sqlite_vector_table}(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`);
    db.run(`create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,user_id))`);
    db.run(`create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)`);
    db.run(`create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`);
    db.run(`create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)`);
    db.run(`create table if not exists temporal_facts(id text primary key,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))`);
    db.run(`create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))`);

    db.run("create index if not exists idx_memories_sector on memories(primary_sector)");
    db.run("create index if not exists idx_memories_segment on memories(segment)");
    db.run("create index if not exists idx_memories_simhash on memories(simhash)");
    db.run("create index if not exists idx_memories_ts on memories(last_seen_at)");
    db.run("create index if not exists idx_memories_user on memories(user_id)");
    db.run(`create index if not exists idx_vectors_user on ${sqlite_vector_table}(user_id)`);
    db.run("create index if not exists idx_waypoints_src on waypoints(src_id)");
    db.run("create index if not exists idx_waypoints_dst on waypoints(dst_id)");
    db.run("create index if not exists idx_waypoints_user on waypoints(user_id)");
    db.run("create index if not exists idx_stats_ts on stats(ts)");
    db.run("create index if not exists idx_stats_type on stats(type)");
    db.run("create index if not exists idx_temporal_subject on temporal_facts(subject)");
    db.run("create index if not exists idx_temporal_predicate on temporal_facts(predicate)");
    db.run("create index if not exists idx_temporal_validity on temporal_facts(valid_from,valid_to)");
    db.run("create index if not exists idx_temporal_composite on temporal_facts(subject,predicate,valid_from,valid_to)");
    db.run("create index if not exists idx_edges_source on temporal_edges(source_id)");
    db.run("create index if not exists idx_edges_target on temporal_edges(target_id)");
    db.run("create index if not exists idx_edges_validity on temporal_edges(valid_from,valid_to)");

    memories_table = "memories";

    // Helper to fix params: Bun sqlite expects ? or $param.
    // Existing code uses ? which is fine for sqlite.
    // But Spread operator in `db.run(sql, params)`?
    // Bun sqlite: `db.run(sql, [p1, p2])` or `db.run(sql, p1, p2)`.
    // Wait, the memory says "internal `bun:sqlite` wrapper... expects query parameters to be passed as a single array argument".
    // Actually, `Database.prototype.run(sql, params)` takes variadic args OR an array in recent versions?
    // If I use `db.run(sql, paramsArray)`, it should work.
    // Let's verify documentation behavior or use safe binding.
    // `db.query(sql).run(...params)` or `db.run(sql, params)`.
    // The previous implementation used a promise wrapper.

    run_async = async (sql: string, p: any[] = []) => {
        db.run(sql, p);
    };
    get_async = async (sql: string, p: any[] = []) => {
        return db.query(sql).get(p as any) as any;
    };
    all_async = async (sql: string, p: any[] = []) => {
        return db.query(sql).all(p as any) as any[];
    };

    if (env.vector_backend === "valkey") {
        vector_store = new ValkeyVectorStore();
        console.log("[DB] Using Valkey VectorStore");
    } else {
        vector_store = new PostgresVectorStore({ run_async, get_async, all_async }, sqlite_vector_table);
        console.log(`[DB] Using SQLite VectorStore with table: ${sqlite_vector_table}`);
    }

    // Transaction support
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

// Define Q object (shared logic mostly, constructing queries)
// Note: The template strings below use ? placeholders.
// If is_pg is true, `run_async` calls `exec` which calls `convertPlaceholders` to switch ? to $n.
// So we can keep using ? in definitions below.

// Common Q definition
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
