import sqlite3 from "sqlite3";
import { env } from "./cfg";
import * as fs from "fs";
import * as path from "path";
import { SQLiteVectorStore, VectorStore } from "./vector_store";

// Constants for table names
export const TABLE_MEMORIES = "memories";
export const TABLE_VECTORS = "vectors";
export const TABLE_WAYPOINTS = "waypoints";
export const TABLE_LOGS = "embed_logs";
export const TABLE_USERS = "users";
export const TABLE_STATS = "stats";
export const TABLE_TF = "temporal_facts";
export const TABLE_TE = "temporal_edges";

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
    get_mems_by_ids: { all: (ids: string[]) => Promise<any[]> }; // Batch retrieval
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
    // ins_vec: { run: (...p: any[]) => Promise<void> };
    get_vec: { get: (id: string, sector: string) => Promise<any> };
    get_vecs_by_id: { all: (id: string) => Promise<any[]> };
    get_vecs_by_sector: { all: (sector: string) => Promise<any[]> };
    get_vecs_batch: { all: (ids: string[], sector: string) => Promise<any[]> };
    // del_vec: { run: (...p: any[]) => Promise<void> };
    del_vec_sector: { run: (...p: any[]) => Promise<void> };
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
    upd_user_summary: { run: (...p: any[]) => Promise<void> };
    // Temporal
    ins_fact: { run: (...p: any[]) => Promise<void> };
    get_facts: { all: (f: { subject?: string; predicate?: string; object?: string; valid_at?: number }) => Promise<any[]> };
    inv_fact: { run: (id: string, valid_to: number) => Promise<void> };
    ins_edge: { run: (...p: any[]) => Promise<void> };
    get_edges: { all: (source_id: string) => Promise<any[]> };
    get_all_user_ids: { all: () => Promise<any[]> };
    get_system_stats: { get: () => Promise<any> };
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
let db: sqlite3.Database | null = null;

export const init_db = (customPath?: string) => {
    if (db) return; // Already initialized

    const db_path = customPath || env.db_path || "./data/openmemory.sqlite";
    const dir = path.dirname(db_path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new sqlite3.Database(db_path);
    db.serialize(() => {
        if (!db) return;
        db.run("PRAGMA journal_mode=WAL");
        db.run("PRAGMA synchronous=NORMAL");
        db.run("PRAGMA temp_store=MEMORY");
        db.run("PRAGMA cache_size=-8000");
        db.run("PRAGMA mmap_size=134217728");
        db.run("PRAGMA foreign_keys=OFF");
        db.run("PRAGMA wal_autocheckpoint=20000");
        db.run("PRAGMA locking_mode=NORMAL");
        db.run("PRAGMA busy_timeout=5000");
        db.run(
            `create table if not exists ${TABLE_MEMORIES}(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`,
        );
        db.run(
            `create table if not exists ${TABLE_VECTORS}(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`,
        );
        db.run(
            `create table if not exists ${TABLE_WAYPOINTS}(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,user_id))`,
        );
        db.run(
            `create table if not exists ${TABLE_LOGS}(id text primary key,model text,status text,ts integer,err text)`,
        );
        db.run(
            `create table if not exists ${TABLE_USERS}(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`,
        );
        db.run(
            `create table if not exists ${TABLE_STATS}(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)`,
        );
        db.run(
            `create table if not exists ${TABLE_TF}(id text primary key,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))`,
        );
        db.run(
            `create table if not exists ${TABLE_TE}(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references ${TABLE_TF}(id),foreign key(target_id) references ${TABLE_TF}(id))`,
        );
        // ... (indices omitted for brevity, assuming they use table names)
    });
};

memories_table = TABLE_MEMORIES;
const exec = (sql: string, p: any[] = []) =>
    new Promise<void>((ok, no) => {
        if (!db) return no(new Error("DB not initialized"));
        db.run(sql, p, (err) => (err ? no(err) : ok()));
    });
const one = (sql: string, p: any[] = []) =>
    new Promise<any>((ok, no) => {
        if (!db) return no(new Error("DB not initialized"));
        db.get(sql, p, (err, row) => (err ? no(err) : ok(row)));
    });
const many = (sql: string, p: any[] = []) =>
    new Promise<any[]>((ok, no) => {
        if (!db) return no(new Error("DB not initialized"));
        db.all(sql, p, (err, rows) => (err ? no(err) : ok(rows)));
    });

run_async = exec;
get_async = one;
all_async = many;

// Initialize VectorStore
const sqlite_vector_table = TABLE_VECTORS;
vector_store = new SQLiteVectorStore({ run_async, get_async, all_async }, sqlite_vector_table);

let txDepth = 0;
transaction = {
    begin: async () => {
        if (txDepth === 0) {
            await exec("BEGIN TRANSACTION");
        }
        txDepth++;
    },
    commit: async () => {
        if (txDepth > 0) txDepth--;
        if (txDepth === 0) {
            await exec("COMMIT");
        }
    },
    rollback: async () => {
        await exec("ROLLBACK");
        txDepth = 0;
    }
};
q = {
    ins_mem: {
        run: (...p) =>
            exec(
                `insert into ${TABLE_MEMORIES}(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                p,
            ),
    },
    upd_mean_vec: {
        run: (...p) =>
            exec(`update ${TABLE_MEMORIES} set mean_dim=?,mean_vec=? where id=?`, p),
    },
    upd_compressed_vec: {
        run: (...p) =>
            exec(`update ${TABLE_MEMORIES} set compressed_vec=? where id=?`, p),
    },
    upd_feedback: {
        run: (...p) =>
            exec(`update ${TABLE_MEMORIES} set feedback_score=? where id=?`, p),
    },
    upd_seen: {
        run: (...p) =>
            exec(
                `update ${TABLE_MEMORIES} set last_seen_at=?,salience=?,updated_at=? where id=?`,
                p,
            ),
    },
    upd_mem: {
        run: (...p) =>
            exec(
                `update ${TABLE_MEMORIES} set content=?,tags=?,meta=?,updated_at=?,version=version+1 where id=?`,
                p,
            ),
    },
    upd_mem_with_sector: {
        run: (...p) =>
            exec(
                `update ${TABLE_MEMORIES} set content=?,primary_sector=?,tags=?,meta=?,updated_at=?,version=version+1 where id=?`,
                p,
            ),
    },
    del_mem: { run: (...p) => exec(`delete from ${TABLE_MEMORIES} where id=?`, p) },
    get_mem: {
        get: (id) => one(`select * from ${TABLE_MEMORIES} where id=?`, [id]),
    },
    get_mems_by_ids: {
        all: async (ids: string[]) => {
            if (ids.length === 0) return Promise.resolve([]);
            const ph = ids.map(() => "?").join(",");
            return many(`select * from ${TABLE_MEMORIES} where id in (${ph})`, ids);
        }
    },
    get_mem_by_simhash: {
        get: (simhash) =>
            one(
                `select * from ${TABLE_MEMORIES} where simhash=? order by salience desc limit 1`,
                [simhash],
            ),
    },
    all_mem: {
        all: (limit, offset) =>
            many(
                `select * from ${TABLE_MEMORIES} order by created_at desc limit ? offset ?`,
                [limit, offset],
            ),
    },
    all_mem_by_sector: {
        all: (sector, limit, offset) =>
            many(
                `select * from ${TABLE_MEMORIES} where primary_sector=? order by created_at desc limit ? offset ?`,
                [sector, limit, offset],
            ),
    },
    get_segment_count: {
        get: (segment) =>
            one(`select count(*) as c from ${TABLE_MEMORIES} where segment=?`, [
                segment,
            ]),
    },
    get_max_segment: {
        get: () =>
            one(
                `select coalesce(max(segment), 0) as max_seg from ${TABLE_MEMORIES}`,
                [],
            ),
    },
    get_segments: {
        all: () =>
            many(
                `select distinct segment from ${TABLE_MEMORIES} order by segment desc`,
                [],
            ),
    },
    get_mem_by_segment: {
        all: (segment) =>
            many(
                `select * from ${TABLE_MEMORIES} where segment=? order by created_at desc`,
                [segment],
            ),
    },
    /*
    ins_vec: {
        run: (...p) =>
            exec(
                `insert into ${TABLE_VECTORS}(id,sector,user_id,v,dim) values(?,?,?,?,?)`,
                p,
            ),
    },
    */
    get_vec: {
        get: (id, sector) =>
            one(`select v,dim from ${TABLE_VECTORS} where id=? and sector=?`, [
                id,
                sector,
            ]),
    },
    get_vecs_by_id: {
        all: (id) =>
            many(`select sector,v,dim from ${TABLE_VECTORS} where id=?`, [id]),
    },
    get_vecs_by_sector: {
        all: (sector) =>
            many(`select id,v,dim from ${TABLE_VECTORS} where sector=?`, [sector]),
    },
    get_vecs_batch: {
        all: (ids: string[], sector: string) => {
            if (!ids.length) return Promise.resolve([]);
            const ph = ids.map(() => "?").join(",");
            return many(
                `select id,v,dim from ${TABLE_VECTORS} where sector=? and id in (${ph})`,
                [sector, ...ids],
            );
        },
    },
    // del_vec: { run: (...p) => exec(`delete from ${TABLE_VECTORS} where id=?`, p) },
    del_vec_sector: {
        run: (...p) =>
            exec(`delete from ${TABLE_VECTORS} where id=? and sector=?`, p),
    },
    ins_waypoint: {
        run: (...p) =>
            exec(
                `insert or replace into ${TABLE_WAYPOINTS}(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?)`,
                p,
            ),
    },
    get_neighbors: {
        all: (src) =>
            many(
                `select dst_id,weight from ${TABLE_WAYPOINTS} where src_id=? order by weight desc`,
                [src],
            ),
    },
    get_waypoints_by_src: {
        all: (src) =>
            many(
                `select src_id,dst_id,weight,created_at,updated_at from ${TABLE_WAYPOINTS} where src_id=?`,
                [src],
            ),
    },
    get_waypoint: {
        get: (src, dst) =>
            one(
                `select weight from ${TABLE_WAYPOINTS} where src_id=? and dst_id=?`,
                [src, dst],
            ),
    },
    upd_waypoint: {
        run: (...p) =>
            exec(
                `update ${TABLE_WAYPOINTS} set weight=?,updated_at=? where src_id=? and dst_id=?`,
                p,
            ),
    },
    del_waypoints: {
        run: (...p) =>
            exec(`delete from ${TABLE_WAYPOINTS} where src_id=? or dst_id=?`, p),
    },
    prune_waypoints: {
        run: (t) => exec(`delete from ${TABLE_WAYPOINTS} where weight<?`, [t]),
    },
    ins_log: {
        run: (...p) =>
            exec(
                `insert or replace into ${TABLE_LOGS}(id,model,status,ts,err) values(?,?,?,?,?)`,
                p,
            ),
    },
    upd_log: {
        run: (...p) =>
            exec(`update ${TABLE_LOGS} set status=?,err=? where id=?`, p),
    },
    get_pending_logs: {
        all: () =>
            many(`select * from ${TABLE_LOGS} where status=?`, ["pending"]),
    },
    get_failed_logs: {
        all: () =>
            many(
                `select * from ${TABLE_LOGS} where status=? order by ts desc limit 100`,
                ["failed"],
            ),
    },
    get_recent_logs: {
        all: (limit: number) => {
            return many(
                `select * from ${TABLE_LOGS} order by ts desc limit ?`,
                [limit],
            );
        }
    },
    all_mem_by_user: {
        all: (user_id, limit, offset) =>
            many(
                `select * from ${TABLE_MEMORIES} where user_id=? order by created_at desc limit ? offset ?`,
                [user_id, limit, offset],
            ),
    },
    ins_user: {
        run: (...p) =>
            exec(
                `insert or replace into ${TABLE_USERS}(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?)`,
                p,
            ),
    },
    get_user: {
        get: (user_id) =>
            one(`select * from ${TABLE_USERS} where user_id=?`, [user_id]),
    },
    upd_user_summary: {
        run: (...p) =>
            exec(
                `update ${TABLE_USERS} set summary=?,reflection_count=reflection_count+1,updated_at=? where user_id=?`,
                p,
            ),
    },
    ins_fact: {
        run: (...p) =>
            exec(
                `insert or replace into ${TABLE_TF}(id,subject,predicate,object,valid_from,valid_to,confidence,last_updated,metadata) values(?,?,?,?,?,?,?,?,?)`,
                p,
            ),
    },
    get_facts: {
        all: (f) => {
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
            return many(sql, params);
        }
    },
    inv_fact: {
        run: (id, valid_to) => exec(`update ${TABLE_TF} set valid_to=?, last_updated=? where id=?`, [valid_to, Date.now(), id]),
    },
    ins_edge: {
        run: (...p) =>
            exec(
                `insert or replace into ${TABLE_TE}(id,source_id,target_id,relation_type,valid_from,valid_to,weight,metadata) values(?,?,?,?,?,?,?,?)`,
                p,
            ),
    },
    get_edges: {
        all: (source_id) => many(`select * from ${TABLE_TE} where source_id=?`, [source_id]),
    },
    get_all_user_ids: {
        all: () => {
            return many(`select distinct user_id from ${TABLE_MEMORIES} where user_id is not null`, []);
        }
    },
    get_system_stats: {
        get: async () => {
            const [totalMemories, totalUsers, requestStats, maintenanceStats] = await Promise.all([
                one(`select count(*) as c from ${TABLE_MEMORIES}`),
                one(`select count(*) as c from ${TABLE_USERS}`),
                many(`select * from ${TABLE_STATS} where type='request' order by ts desc limit 60`),
                many(`select * from ${TABLE_STATS} where type in ('decay','reflect','consolidate') order by ts desc limit 50`)
            ]);
            return { totalMemories, totalUsers, requestStats, maintenanceStats };
        }
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
        console.error("[DB] Maintenance log error:", e);
    }
};

export { q, transaction, all_async, get_async, run_async, memories_table, vector_store };
