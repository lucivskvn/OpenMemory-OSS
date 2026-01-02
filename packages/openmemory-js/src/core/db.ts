import { Database } from "bun:sqlite";
import { Pool, PoolClient } from "pg";
import { env } from "./cfg";
import fs from "node:fs";
import path from "node:path";
import { VectorStore } from "./vector_store";
import { SqlVectorStore } from "./vector/sql";
import { ValkeyVectorStore } from "./vector/valkey";

import { MemoryRow, SectorStat, LogEntry, AddMemoryRequest, QueryMemoryRequest, TemporalFact, TemporalEdge } from "./types";

export type SqlValue = string | number | boolean | null | Uint8Array | Date;
export type SqlParams = SqlValue[];

type q_type = {
    ins_mem: { run: (...p: SqlParams) => Promise<number> };
    upd_mean_vec: {
        run: (
            id: string,
            dim: number,
            vec: Buffer | Uint8Array,
            user_id?: string,
        ) => Promise<number>;
    };
    upd_compressed_vec: {
        run: (id: string, vec: Buffer | Uint8Array, user_id?: string) => Promise<number>;
    };
    upd_feedback: {
        run: (
            id: string,
            feedback_score: number,
            user_id?: string,
        ) => Promise<number>;
    };
    upd_seen: {
        run: (
            id: string,
            last_seen_at: number,
            salience: number,
            updated_at: number,
            user_id?: string,
        ) => Promise<number>;
    };
    upd_summary: {
        run: (id: string, summary: string, user_id?: string) => Promise<number>;
    };
    upd_mem: {
        run: (
            content: string,
            tags: string | null,
            meta: string | null,
            updated_at: number,
            id: string,
            user_id?: string,
        ) => Promise<number>;
    };
    upd_mem_with_sector: {
        run: (
            content: string,
            sector: string,
            tags: string | null,
            meta: string | null,
            updated_at: number,
            id: string,
            user_id?: string,
        ) => Promise<number>;
    };
    del_mem: { run: (id: string, user_id?: string) => Promise<number> };
    get_mem: {
        get: (id: string, user_id?: string) => Promise<MemoryRow | undefined>;
    };
    get_mem_by_simhash: { get: (simhash: string, user_id?: string) => Promise<MemoryRow | undefined> };
    get_active_users: { all: () => Promise<{ user_id: string }[]> };
    all_mem: { all: (limit: number, offset: number) => Promise<MemoryRow[]> };
    all_mem_by_sector: {
        all: (sector: string, limit: number, offset: number, user_id?: string) => Promise<MemoryRow[]>;
    };
    get_training_data: {
        all: (user_id: string, limit: number) => Promise<Array<{ primary_sector: string, mean_vec: Uint8Array }>>;
    };
    all_mem_by_user: {
        all: (user_id: string, limit: number, offset: number) => Promise<MemoryRow[]>;
    };
    get_segment_count: { get: (segment: number) => Promise<{ c: number } | undefined> };
    get_max_segment: { get: () => Promise<{ max_seg: number } | undefined> };
    get_segments: { all: () => Promise<{ segment: number }[]> };
    get_mem_by_segment: { all: (segment: number) => Promise<MemoryRow[]> };
    del_mem_by_user: { run: (user_id: string) => Promise<number> };

    // Waypoints
    ins_waypoint: { run: (...p: SqlParams) => Promise<number> };
    get_neighbors: { all: (src: string, user_id?: string) => Promise<{ dst_id: string; weight: number }[]> };
    get_waypoints_by_src: { all: (src: string, user_id?: string) => Promise<{ src_id: string; dst_id: string; weight: number; created_at: number; updated_at: number }[]> };
    get_waypoint: { get: (src: string, dst: string, user_id?: string) => Promise<{ weight: number; user_id: string; created_at: number; updated_at: number } | undefined> };
    upd_waypoint: { run: (...p: SqlParams) => Promise<number> };
    del_waypoints: { run: (...p: SqlParams) => Promise<number> };
    prune_waypoints: { run: (threshold: number, user_id?: string) => Promise<number> };

    // Logs
    ins_log: { run: (...p: SqlParams) => Promise<number> };
    upd_log: { run: (...p: SqlParams) => Promise<number> };
    get_pending_logs: { all: () => Promise<LogEntry[]> };
    get_failed_logs: { all: () => Promise<LogEntry[]> };

    // Users
    ins_user: { run: (...p: SqlParams) => Promise<number> };
    get_user: { get: (user_id: string) => Promise<{ user_id: string; summary: string; reflection_count: number; created_at: number; updated_at: number } | undefined> };
    upd_user_summary: { run: (...p: SqlParams) => Promise<number> };
    clear_all: { run: () => Promise<void> };
    get_mem_by_meta_like: { all: (pattern: string, user_id?: string) => Promise<MemoryRow[]> };
    get_sector_stats: { all: (user_id?: string) => Promise<SectorStat[]> };

    // Classifier Models
    get_classifier_model: {
        get: (user_id: string) => Promise<{
            user_id: string;
            weights: string;
            biases: string;
            version: number;
            updated_at: number;
        } | undefined>;
    };
    get_tables: {
        all: () => Promise<{ name: string }[]>;
    };
    ins_classifier_model: {
        run: (
            user_id: string,
            weights: string,
            biases: string,
            version: number,
            updated_at: number,
        ) => Promise<number>;
    };
};

export let run_async: (sql: string, p?: SqlParams) => Promise<number>;
export let get_async: <T = any>(sql: string, p?: SqlParams) => Promise<T>;
export let all_async: <T = any>(sql: string, p?: SqlParams) => Promise<T[]>;
/**
 * Global transaction management abstraction.
 * Note: Check specific backend implementation nuances.
 */
let transaction: {
    begin: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
};
export let close_db: () => Promise<void> = async () => { };
let q: q_type;
let vector_store: VectorStore;
let memories_table: string;

const is_pg = env.metadata_backend === "postgres";

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, $3 placeholders
function convertPlaceholders(sql: string): string {
    if (!is_pg) return sql;
    let index = 1;
    return sql.replace(/\?/g, () => `$${index++}`);
}

if (is_pg) {
    const ssl =
        process.env.OM_PG_SSL === "require"
            ? { rejectUnauthorized: false }
            : process.env.OM_PG_SSL === "disable"
                ? false
                : undefined;
    const db_name = process.env.OM_PG_DB || "openmemory";
    const pool = (db: string) =>
        new Pool({
            host: process.env.OM_PG_HOST,
            port: process.env.OM_PG_PORT ? +process.env.OM_PG_PORT : undefined,
            database: db,
            user: process.env.OM_PG_USER,
            password: process.env.OM_PG_PASSWORD,
            ssl,
        });
    let pg = pool(db_name);
    let cli: PoolClient | null = null;
    const sc = process.env.OM_PG_SCHEMA || "public";
    const m = `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"`;
    memories_table = m;
    const v = `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`;
    const w = `"${sc}"."openmemory_waypoints"`;
    const l = `"${sc}"."openmemory_embed_logs"`;
    const tf = `"${sc}"."openmemory_temporal_facts"`;
    const te = `"${sc}"."openmemory_temporal_edges"`;
    const st = `"${sc}"."openmemory_stats"`;
    const f = `"${sc}"."openmemory_memories_fts"`;
    const exec_res = async (sql: string, p: any[] = []) => {
        const c = cli || pg;
        return await c.query(convertPlaceholders(sql), p);
    };
    const exec = async (sql: string, p: any[] = []) => {
        return (await exec_res(sql, p)).rows;
    };
    run_async = async (sql, p = []) => {
        return (await exec_res(sql, p)).rowCount || 0;
    };
    get_async = async (sql, p = []) => (await exec(sql, p))[0];
    all_async = async (sql, p = []) => await exec(sql, p);
    transaction = {
        begin: async () => {
            if (cli) throw new Error("transaction active");
            cli = await pg.connect();
            await cli.query("BEGIN");
        },
        commit: async () => {
            if (!cli) return;
            try {
                await cli.query("COMMIT");
            } finally {
                cli.release();
                cli = null;
            }
        },
        rollback: async () => {
            if (!cli) return;
            try {
                await cli.query("ROLLBACK");
            } finally {
                cli.release();
                cli = null;
            }
        },
    };
    close_db = async () => {
        if (pg) await pg.end();
        if (vector_store && typeof vector_store.disconnect === 'function') {
            await vector_store.disconnect();
        }
    };
    let ready = false;
    const wait_ready = () =>
        new Promise<void>((ok) => {
            const check = () => (ready ? ok() : setTimeout(check, 10));
            check();
        });
    const init = async () => {
        try {
            await pg.query("SELECT 1");
        } catch (err: any) {
            if (err.code === "3D000") {
                const admin = pool("postgres");
                try {
                    await admin.query(`CREATE DATABASE ${db_name}`);
                    if (env.verbose) console.log(`[DB] Created ${db_name}`);
                } catch (e: any) {
                    if (e.code !== "42P04") throw e;
                } finally {
                    await admin.end();
                }
                pg = pool(db_name);
                await pg.query("SELECT 1");
            } else throw err;
        }
        await pg.query(
            `create table if not exists ${m}(id uuid primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at bigint,updated_at bigint,last_seen_at bigint,salience double precision,decay_lambda double precision,version integer default 1,mean_dim integer,mean_vec bytea,compressed_vec bytea,feedback_score double precision default 0)`,
        );
        await pg.query(
            `create table if not exists ${v}(id uuid,sector text,user_id text,v bytea,dim integer not null,primary key(id,sector))`,
        );
        await pg.query(
            `create table if not exists ${w}(src_id text,dst_id text not null,user_id text,weight double precision not null,created_at bigint,updated_at bigint,primary key(src_id,dst_id,user_id))`,
        );
        await pg.query(
            `create table if not exists ${l}(id text primary key,user_id text,model text,status text,ts bigint,err text)`,
        );
        await pg.query(`ALTER TABLE ${l} ADD COLUMN IF NOT EXISTS user_id text`);
        await pg.query(
            `create table if not exists "${sc}"."openmemory_users"(user_id text primary key,summary text,reflection_count integer default 0,created_at bigint,updated_at bigint)`,
        );
        await pg.query(
            `create table if not exists ${st}(id serial primary key,type text not null,count integer default 1,ts bigint not null)`,
        );
        await pg.query(
            `create table if not exists ${tf}(id text primary key,user_id text,subject text not null,predicate text not null,object text not null,valid_from bigint not null,valid_to bigint,confidence double precision not null check(confidence >= 0 and confidence <= 1),last_updated bigint not null,metadata text,unique(user_id,subject,predicate,object,valid_from))`,
        );
        await pg.query(
            `create table if not exists ${te}(id text primary key,user_id text,source_id text not null,target_id text not null,relation_type text not null,valid_from bigint not null,valid_to bigint,weight double precision not null,metadata text,foreign key(source_id) references ${tf}(id),foreign key(target_id) references ${tf}(id))`,
        );
        // Migrations: ensure user_id exists if table already existed
        await pg.query(`ALTER TABLE ${tf} ADD COLUMN IF NOT EXISTS user_id text`);
        await pg.query(`ALTER TABLE ${te} ADD COLUMN IF NOT EXISTS user_id text`);
        await pg.query(`ALTER TABLE ${w} ADD COLUMN IF NOT EXISTS user_id text`);
        // Note: For unique constraint changes in PG, we might need more complex logic if it already existed without user_id.
        // But for now we prioritize getting the columns in.
        await pg.query(
            `create index if not exists openmemory_memories_sector_idx on ${m}(primary_sector)`,
        );
        await pg.query(
            `create index if not exists openmemory_memories_segment_idx on ${m}(segment)`,
        );
        await pg.query(
            `create index if not exists openmemory_memories_simhash_idx on ${m}(simhash)`,
        );
        await pg.query(
            `create index if not exists openmemory_memories_user_idx on ${m}(user_id)`,
        );
        await pg.query(
            `create index if not exists openmemory_vectors_user_idx on ${v}(user_id)`,
        );
        await pg.query(
            `create index if not exists openmemory_waypoints_user_idx on ${w}(user_id)`,
        );
        await pg.query(
            `create index if not exists openmemory_stats_ts_idx on ${st}(ts)`,
        );
        await pg.query(
            `create index if not exists openmemory_embed_logs_user_idx on ${l}(user_id)`,
        );
        await pg.query(
            `create index if not exists openmemory_stats_type_idx on ${st}(type)`,
        );
        await pg.query(
            `create index if not exists openmemory_temporal_subject_idx on ${tf}(subject)`,
        );
        await pg.query(
            `create index if not exists openmemory_temporal_predicate_idx on ${tf}(predicate)`,
        );
        // Composite indexes for user-scoped queries
        await pg.query(
            `create index if not exists openmemory_mem_user_sector_idx on ${m}(user_id, primary_sector)`,
        );
        await pg.query(
            `create index if not exists openmemory_mem_user_ts_idx on ${m}(user_id, last_seen_at)`,
        );
        await pg.query(
            `create index if not exists openmemory_temporal_user_subject_idx on ${tf}(user_id, subject)`,
        );
        await pg.query(
            `create index if not exists openmemory_temporal_user_edges_idx on ${te}(user_id, source_id, target_id)`,
        );
        await pg.query(
            `create index if not exists openmemory_temporal_validity_idx on ${tf}(valid_from,valid_to)`,
        );
        await pg.query(
            `create index if not exists openmemory_edges_source_idx on ${te}(source_id)`,
        );
        await pg.query(
            `create index if not exists openmemory_edges_target_idx on ${te}(target_id)`,
        );
        await pg.query(
            `create table if not exists learned_models(user_id text primary key,weights text,biases text,version integer default 1,updated_at bigint)`,
        );
        ready = true;

        // Initialize VectorStore
        if (env.vector_backend === "valkey") {
            vector_store = new ValkeyVectorStore();
            console.log("[DB] Using Valkey VectorStore");
        } else {
            const vt = process.env.OM_VECTOR_TABLE || "openmemory_vectors";
            vector_store = new SqlVectorStore({ run_async, get_async, all_async }, v.replace(/"/g, ""));
            if (env.verbose) console.log(`[DB] Using Postgres VectorStore with table: ${v}`);
        }
    };
    init().catch((err) => {
        console.error("[DB] Init failed:", err);
        process.exit(1);
    });
    const safe_exec = async (sql: string, p: any[] = []) => {
        await wait_ready();
        return exec(sql, p);
    };
    const safe_exec_rowCount = async (sql: string, p: any[] = []) => {
        await wait_ready();
        const res = await exec_res(sql, p);
        return res.rowCount || 0;
    };
    run_async = async (sql, p = []) => {
        return await safe_exec_rowCount(sql, p);
    };
    get_async = async (sql, p = []) => (await safe_exec(sql, p))[0];
    all_async = async (sql, p = []) => await safe_exec(sql, p);
    const clean = (s: string) =>
        s ? s.replace(/"/g, "").replace(/\s+OR\s+/gi, " OR ") : "";

    /**
     * Unified Query Interface supporting both PostgreSQL and SQLite backends.
     * Abstraction layer to handle SQL dialect differences and provide type-safe data access.
     */
    q = {
        ins_mem: {
            run: (...p) =>
                run_async(
                    `insert into ${m}(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) on conflict(id) do update set user_id=excluded.user_id,segment=excluded.segment,content=excluded.content,simhash=excluded.simhash,primary_sector=excluded.primary_sector,tags=excluded.tags,meta=excluded.meta,created_at=excluded.created_at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience,decay_lambda=excluded.decay_lambda,version=excluded.version,mean_dim=excluded.mean_dim,mean_vec=excluded.mean_vec,compressed_vec=excluded.compressed_vec,feedback_score=excluded.feedback_score`,
                    p,
                ),
        },
        upd_mean_vec: {
            run: (id: string, dim: number, vec: Buffer, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $4" : "";
                const p: any[] = [id, dim, vec];
                if (user_id) p.push(user_id);
                return run_async(
                    `update ${m} set mean_dim=$2,mean_vec=$3 where id=$1 ${user_clause}`,
                    p,
                );
            }
        },
        upd_compressed_vec: {
            run: (id: string, vec: Buffer, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $3" : "";
                const p: any[] = [id, vec];
                if (user_id) p.push(user_id);
                return run_async(`update ${m} set compressed_vec=$2 where id=$1 ${user_clause}`, p);
            }
        },
        upd_feedback: {
            run: (id: string, feedback_score: number, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $3" : "";
                const p: any[] = [id, feedback_score];
                if (user_id) p.push(user_id);
                return run_async(`update ${m} set feedback_score=$2 where id=$1 ${user_clause}`, p);
            }
        },
        upd_seen: {
            run: (id: string, last_seen_at: number, salience: number, updated_at: number, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $5" : "";
                const p = [id, last_seen_at, salience, updated_at];
                if (user_id) p.push(user_id);
                return run_async(
                    `update ${m} set last_seen_at=$2,salience=$3,updated_at=$4 where id=$1 ${user_clause}`,
                    p as any,
                );
            }
        },
        upd_summary: {
            run: (id: string, summary: string, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $3" : "";
                const p: any[] = [id, summary];
                if (user_id) p.push(user_id);
                return run_async(`update ${m} set summary=$2 where id=$1 ${user_clause}`, p);
            }
        },
        upd_mem: {
            run: (content: string, tags: string | null, meta: string | null, updated_at: number, id: string, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $6" : "";
                const p: any[] = [content, tags, meta, updated_at, id];
                if (user_id) p.push(user_id);
                return run_async(
                    `update ${m} set content=$1,tags=$2,meta=$3,updated_at=$4,version=version+1 where id=$5 ${user_clause}`,
                    p,
                );
            }
        },
        upd_mem_with_sector: {
            run: (content: string, sector: string, tags: string | null, meta: string | null, updated_at: number, id: string, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $7" : "";
                const p: any[] = [content, sector, tags, meta, updated_at, id];
                if (user_id) p.push(user_id);
                return run_async(
                    `update ${m} set content=$1,primary_sector=$2,tags=$3,meta=$4,updated_at=$5,version=version+1 where id=$6 ${user_clause}`,
                    p,
                );
            }
        },
        del_mem: {
            run: async (id: string, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $2" : "";
                const p = user_id ? [id, user_id] : [id];
                await run_async(`delete from ${v} where id=$1 ${user_clause}`, p as any);
                const w_clause = user_id ? "and user_id = $2" : "";
                await run_async(`delete from ${w} where (src_id=$1 or dst_id=$1) ${w_clause}`, p as any);
                return await run_async(`delete from ${m} where id=$1 ${user_clause}`, p as any);
            },
        },
        get_classifier_model: {
            get: (user_id: string) => get_async(`select * from learned_models where user_id=$1`, [user_id]),
        },
        ins_classifier_model: {
            run: (user_id, weights, biases, version, updated_at) =>
                run_async(
                    `insert into learned_models(user_id,weights,biases,version,updated_at) values($1,$2,$3,$4,$5) on conflict(user_id) do update set weights=$2,biases=$3,version=$4,updated_at=$5`,
                    [user_id, weights, biases, version, updated_at],
                ),
        },
        get_mem: {
            get: (id: string, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $2" : "";
                const p = [id];
                if (user_id) p.push(user_id);
                return get_async(`select * from ${m} where id=$1 ${user_clause}`, p as any);
            }
        },
        get_mem_by_simhash: {
            get: (simhash, user_id) => {
                const user_clause = user_id ? "user_id = $2" : "1=1";
                const p = user_id ? [simhash, user_id] : [simhash];
                return get_async(`select * from ${m} where simhash=$1 and ${user_clause} order by salience desc limit 1`, p);
            }
        },
        get_active_users: {
            all: () =>
                all_async(
                    `select distinct user_id from ${m} where user_id is not null`,
                ),
        },
        all_mem: {
            all: (limit, offset) =>
                all_async(
                    `select * from ${m} order by created_at desc limit $1 offset $2`,
                    [limit, offset],
                ),
        },
        all_mem_by_sector: {
            all: (sector, limit, offset, user_id) => {
                const user_clause = user_id ? "and user_id=$4" : "";
                const p = user_id ? [sector, limit, offset, user_id] : [sector, limit, offset];
                return all_async(
                    `select * from ${m} where primary_sector=$1 ${user_clause} order by created_at desc limit $2 offset $3`,
                    p,
                );
            },
        },
        get_training_data: {
            all: (user_id, limit) =>
                all_async(
                    `select primary_sector, mean_vec from ${m} where user_id=$1 and mean_vec is not null limit $2`,
                    [user_id, limit],
                ) as any,
        },
        get_segment_count: {
            get: (segment) =>
                get_async(`select count(*) as c from ${m} where segment=$1`, [
                    segment,
                ]),
        },
        get_max_segment: {
            get: () =>
                get_async(
                    `select coalesce(max(segment), 0) as max_seg from ${m}`,
                    [],
                ),
        },
        get_segments: {
            all: () =>
                all_async(
                    `select distinct segment from ${m} order by segment desc`,
                    [],
                ),
        },
        get_mem_by_segment: {
            all: (segment) =>
                all_async(
                    `select * from ${m} where segment=$1 order by created_at desc`,
                    [segment],
                ),
        },
        // Vector operations removed
        ins_waypoint: {
            run: (...p) =>
                run_async(
                    `insert into ${w}(src_id,dst_id,user_id,weight,created_at,updated_at) values($1,$2,$3,$4,$5,$6) on conflict(src_id,dst_id,user_id) do update set weight=excluded.weight,updated_at=excluded.updated_at`,
                    p,
                ),
        },
        get_neighbors: {
            all: (src, user_id) => {
                const user_clause = user_id ? "and user_id=$2" : "";
                const p = user_id ? [src, user_id] : [src];
                return all_async(
                    `select dst_id,weight from ${w} where src_id=$1 ${user_clause} order by weight desc`,
                    p,
                );
            },
        },
        get_waypoints_by_src: {
            all: (src, user_id) => {
                const user_clause = user_id ? "and user_id=$2" : "";
                const p = user_id ? [src, user_id] : [src];
                return all_async(
                    `select src_id,dst_id,weight,created_at,updated_at from ${w} where src_id=$1 ${user_clause}`,
                    p,
                );
            },
        },
        get_waypoint: {
            get: (src, dst, user_id) => {
                const user_clause = user_id ? "and user_id=$3" : "";
                const p = user_id ? [src, dst, user_id] : [src, dst];
                return get_async(
                    `select weight, user_id, created_at, updated_at from ${w} where src_id=$1 and dst_id=$2 ${user_clause}`,
                    p,
                );
            },
        },
        upd_waypoint: {
            run: (...p) => {
                // p: [src_id, weight, updated_at, dst_id, user_id]
                const user_id = p[4];
                const user_clause = user_id ? "and user_id=$5" : "";
                const params = user_id ? p : p.slice(0, 4);
                return run_async(
                    `update ${w} set weight=$2,updated_at=$3 where src_id=$1 and dst_id=$4 ${user_clause}`,
                    params,
                );
            },
        },
        del_waypoints: {
            run: (...p) => {
                // p: [id, id, user_id]
                const user_id = p[2];
                const user_clause = user_id ? "and user_id=$3" : "";
                const params = user_id ? p : p.slice(0, 2);
                return run_async(`delete from ${w} where (src_id=$1 or dst_id=$2) ${user_clause}`, params);
            },
        },
        prune_waypoints: {
            run: (t, user_id) => {
                const user_clause = user_id ? "and user_id=$2" : "";
                const p = user_id ? [t, user_id] : [t];
                return run_async(`delete from ${w} where weight<$1 ${user_clause}`, p);
            },
        },
        ins_log: {
            run: (...p) =>
                run_async(
                    `insert into ${l}(id,user_id,model,status,ts,err) values($1,$2,$3,$4,$5,$6) on conflict(id) do update set user_id=excluded.user_id,model=excluded.model,status=excluded.status,ts=excluded.ts,err=excluded.err`,
                    p,
                ),
        },
        upd_log: {
            run: (...p) =>
                run_async(`update ${l} set status=$2,err=$3 where id=$1`, p),
        },
        get_pending_logs: {
            all: () =>
                all_async(`select * from ${l} where status=$1`, ["pending"]),
        },
        get_failed_logs: {
            all: () =>
                all_async(
                    `select * from ${l} where status=$1 order by ts desc limit 100`,
                    ["failed"],
                ),
        },
        all_mem_by_user: {
            all: (user_id, limit, offset) =>
                all_async(
                    `select * from ${m} where user_id=$1 order by created_at desc limit $2 offset $3`,
                    [user_id, limit, offset],
                ),
        },
        del_mem_by_user: {
            run: async (user_id: string) => {
                await run_async(`delete from ${v} where user_id=$1`, [user_id]);
                await run_async(`delete from ${w} where user_id=$1`, [user_id]);
                await run_async(`delete from temporal_facts where user_id=$1`, [user_id]);
                await run_async(`delete from temporal_edges where user_id=$1`, [user_id]);
                return await run_async(`delete from ${m} where user_id=$1`, [user_id]);
            },
        },
        ins_user: {
            run: (...p) =>
                run_async(
                    `insert into "${sc}"."openmemory_users"(user_id,summary,reflection_count,created_at,updated_at) values($1,$2,$3,$4,$5) on conflict(user_id) do update set summary=excluded.summary,reflection_count=excluded.reflection_count,updated_at=excluded.updated_at`,
                    p,
                ),
        },
        get_user: {
            get: (user_id) =>
                get_async(
                    `select * from "${sc}"."openmemory_users" where user_id=$1`,
                    [user_id],
                ),
        },
        upd_user_summary: {
            run: (...p) =>
                run_async(
                    `update "${sc}"."openmemory_users" set summary=$2,reflection_count=reflection_count+1,updated_at=$3 where user_id=$1`,
                    p,
                ),
        },
        clear_all: {
            run: async () => {
                await run_async(`delete from ${m}`);
                await run_async(`delete from ${v}`);
                await run_async(`delete from ${w}`);
                await run_async(`delete from "${sc}"."openmemory_users"`);
                await run_async(`delete from temporal_facts`);
                await run_async(`delete from temporal_edges`);
            },
        },
        get_mem_by_meta_like: {
            all: (pattern: string, user_id?: string) => {
                const user_clause = user_id ? "and user_id = $2" : "";
                const p = user_id ? [`%${pattern}%`, user_id] : [`%${pattern}%`];
                return all_async(
                    `select * from ${memories_table} where meta like $1 ${user_clause} order by created_at desc`,
                    p as any,
                );
            }
        },
        get_sector_stats: {
            all: (user_id) => {
                const user_clause = user_id ? "WHERE user_id = $1" : "WHERE user_id IS NULL";
                const p = user_id ? [user_id] : [];
                return all_async(
                    `select primary_sector as sector, count(*) as count, avg(salience) as avg_salience from ${memories_table} ${user_clause} group by primary_sector`,
                    p,
                ) as Promise<SectorStat[]>;
            }
        },
    };
} else {
    const db_path =
        env.db_path ||
        path.resolve(__dirname, "../../data/openmemory.sqlite");
    const dir = path.dirname(db_path);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Bun:sqlite native database
    const db = new Database(db_path, { create: true });

    // SQLite vector table name from env (default: "vectors" for backward compatibility)
    const sqlite_vector_table = process.env.OM_VECTOR_TABLE || "vectors";

    // WAL mode and settings
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA temp_store=MEMORY");
    db.exec("PRAGMA cache_size=-8000");
    db.exec("PRAGMA mmap_size=134217728");
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("PRAGMA wal_autocheckpoint=20000");
    db.exec("PRAGMA locking_mode=NORMAL");
    db.exec("PRAGMA busy_timeout=5000");

    close_db = async () => {
        db.close();
        if (vector_store && typeof (vector_store as any).disconnect === 'function') {
            await (vector_store as any).disconnect();
        }
    };

    // SQLite Migrations: ensure user_id column exists
    const ensureColumn = (table: string, column: string, type: string) => {
        const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        if (!info.some(c => c.name === column)) {
            console.error(`[DB] Migration: Adding ${column} to ${table}`);
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
    };

    db.exec(`create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`);
    db.exec(`create table if not exists ${sqlite_vector_table}(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`);
    db.exec(`create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,dst_id,user_id))`);
    db.exec(`create table if not exists embed_logs(id text primary key,user_id text,model text,status text,ts integer,err text)`);
    db.exec(`create table if not exists temporal_facts (id text primary key,user_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(user_id,subject,predicate,object,valid_from))`);
    db.exec(`create table if not exists temporal_edges (id text primary key,user_id text,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))`);
    db.exec(`create table if not exists learned_models(user_id text primary key,weights text,biases text,version integer default 1,updated_at integer)`);
    ensureColumn("embed_logs", "user_id", "text");
    ensureColumn("temporal_facts", "user_id", "text");
    ensureColumn("temporal_edges", "user_id", "text");
    ensureColumn("waypoints", "user_id", "text");
    ensureColumn("memories", "user_id", "text");
    ensureColumn(sqlite_vector_table, "user_id", "text");

    // SQLite Migration: fix waypoints primary key if it was created wrongly
    try {
        const wpInfo = db.prepare("PRAGMA table_info(waypoints)").all() as any[];
        const pkCount = wpInfo.filter(c => c.pk > 0).length;
        if (pkCount === 2) { // Old (src_id, user_id)
            console.error("[DB] Migration: Re-creating waypoints table with correct primary key");
            db.exec("BEGIN TRANSACTION");
            db.exec("ALTER TABLE waypoints RENAME TO waypoints_old");
            db.exec("create table waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,dst_id,user_id))");
            db.exec("insert into waypoints select * from waypoints_old");
            db.exec("drop table waypoints_old");
            db.exec("COMMIT");
        }
    } catch (e) {
        console.warn("[DB] Waypoints migration check failed:", e);
    }

    db.exec("create index if not exists idx_memories_sector on memories(primary_sector)");
    db.exec("create index if not exists idx_memories_segment on memories(segment)");
    db.exec("create index if not exists idx_memories_simhash on memories(simhash)");
    db.exec("create index if not exists idx_memories_ts on memories(last_seen_at)");
    db.exec("create index if not exists idx_memories_user on memories(user_id)");
    db.exec(`create index if not exists idx_vectors_user on ${sqlite_vector_table}(user_id)`);
    db.exec("create index if not exists idx_waypoints_src on waypoints(src_id)");
    db.exec("create index if not exists idx_waypoints_dst on waypoints(dst_id)");
    db.exec("create index if not exists idx_waypoints_user on waypoints(user_id)");
    db.exec("create index if not exists idx_stats_ts on stats(ts)");
    db.exec("create index if not exists idx_stats_type on stats(type)");
    db.exec("create index if not exists idx_embed_logs_user on embed_logs(user_id)");

    // Composite indexes for user-scoped queries
    db.exec("create index if not exists idx_mem_user_sector on memories(user_id, primary_sector)");
    db.exec("create index if not exists idx_mem_user_ts on memories(user_id, last_seen_at)");
    db.exec("create index if not exists idx_tf_user_subject on temporal_facts(user_id, subject)");
    db.exec("create index if not exists idx_te_user_src_dst on temporal_edges(user_id, source_id, target_id)");
    db.exec("create index if not exists idx_temporal_user on temporal_facts(user_id)");
    db.exec("create index if not exists idx_temporal_subject on temporal_facts(subject)");
    db.exec("create index if not exists idx_temporal_predicate on temporal_facts(predicate)");
    db.exec("create index if not exists idx_temporal_validity on temporal_facts(valid_from,valid_to)");
    db.exec("create index if not exists idx_temporal_composite on temporal_facts(user_id,subject,predicate,valid_from,valid_to)");
    db.exec("create index if not exists idx_edges_user on temporal_edges(user_id)");
    db.exec("create index if not exists idx_edges_source on temporal_edges(source_id)");
    db.exec("create index if not exists idx_edges_target on temporal_edges(target_id)");
    db.exec("create index if not exists idx_edges_validity on temporal_edges(valid_from,valid_to)");

    memories_table = "memories";

    transaction = {
        begin: async () => { db.exec("BEGIN TRANSACTION"); },
        commit: async () => { db.exec("COMMIT"); },
        rollback: async () => { db.exec("ROLLBACK"); }
    };

    // Statement Caching
    const stmt_cache = new Map<string, any>();
    const get_stmt = (sql: string) => {
        let stmt = stmt_cache.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            stmt_cache.set(sql, stmt);
        }
        return stmt;
    };

    const exec_rowCount = (sql: string, p: any[] = []) =>
        new Promise<number>((ok, no) => {
            try {
                const res = get_stmt(sql).run(...p);
                ok(res.changes);
            } catch (e) { no(e); }
        });
    const one = (sql: string, p: any[] = []) =>
        new Promise<any>((ok, no) => {
            try {
                ok(get_stmt(sql).get(...p));
            } catch (e) { no(e); }
        });
    const many = (sql: string, p: any[] = []) =>
        new Promise<any[]>((ok, no) => {
            try {
                ok(get_stmt(sql).all(...p));
            } catch (e) { no(e); }
        });

    run_async = exec_rowCount;
    get_async = one;
    all_async = many;

    // Initialize VectorStore (SQLite uses PostgresVectorStore impl internally via DbOps if backend is postgres)
    if (env.vector_backend === "valkey") {
        vector_store = new ValkeyVectorStore();
        if (env.verbose) console.log("[DB] SQLite with Valkey VectorStore");
    } else {
        vector_store = new SqlVectorStore({ run_async, get_async, all_async }, sqlite_vector_table);
        if (env.verbose) console.log(`[DB] SQLite with internal SqlVectorStore (table: ${sqlite_vector_table})`);
    }
    q = {
        ins_mem: {
            run: (...p) =>
                exec_rowCount(
                    "insert into memories(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    p,
                ),
        },
        upd_mean_vec: {
            run: (id, dim, vec, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [dim, vec, id, user_id] : [dim, vec, id];
                return exec_rowCount(`update memories set mean_dim=?,mean_vec=? where id=? ${user_clause}`, p as any);
            }
        },
        upd_compressed_vec: {
            run: (id, vec, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [vec, id, user_id] : [vec, id];
                return exec_rowCount(`update memories set compressed_vec=? where id=? ${user_clause}`, p as any);
            }
        },
        upd_feedback: {
            run: (id, feedback_score, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [feedback_score, id, user_id] : [feedback_score, id];
                return exec_rowCount(`update memories set feedback_score=? where id=? ${user_clause}`, p as any);
            }
        },
        upd_seen: {
            run: (id, last_seen_at, salience, updated_at, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [last_seen_at, salience, updated_at, id, user_id] : [last_seen_at, salience, updated_at, id];
                return exec_rowCount(
                    `update memories set last_seen_at=?,salience=?,updated_at=? where id=? ${user_clause}`,
                    p as any,
                );
            }
        },
        upd_summary: {
            run: (id, summary, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [summary, id, user_id] : [summary, id];
                return exec_rowCount(`update memories set summary=? where id=? ${user_clause}`, p as any);
            }
        },
        upd_mem: {
            run: (content, tags, meta, updated_at, id, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [content, tags, meta, updated_at, id, user_id] : [content, tags, meta, updated_at, id];
                return exec_rowCount(
                    `update memories set content=?,tags=?,meta=?,updated_at=?,version=version+1 where id=? ${user_clause}`,
                    p as any,
                );
            }
        },
        upd_mem_with_sector: {
            run: (content, sector, tags, meta, updated_at, id, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [content, sector, tags, meta, updated_at, id, user_id] : [content, sector, tags, meta, updated_at, id];
                return exec_rowCount(
                    `update memories set content=?,primary_sector=?,tags=?,meta=?,updated_at=?,version=version+1 where id=? ${user_clause}`,
                    p as any,
                );
            }
        },
        get_classifier_model: {
            get: (user_id: string) => one(`select * from learned_models where user_id=?`, [user_id]),
        },
        ins_classifier_model: {
            run: (user_id, weights, biases, version, updated_at) =>
                exec_rowCount(
                    `insert or replace into learned_models(user_id,weights,biases,version,updated_at) values(?,?,?,?,?)`,
                    [user_id, weights, biases, version, updated_at],
                ),
        },
        del_mem: {
            run: async (id: string, user_id?: string) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [id, user_id] : [id];
                await exec_rowCount(`delete from ${sqlite_vector_table} where id=? ${user_clause}`, p as any);
                const w_clause = user_id ? "and user_id = ?" : "";
                await exec_rowCount(`delete from waypoints where (src_id=? or dst_id=?) ${w_clause}`, [id, id, ...(user_id ? [user_id] : [])] as any);
                return await exec_rowCount(`delete from memories where id=? ${user_clause}`, p as any);
            },
        },
        get_mem: {
            get: (id, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [id, user_id] : [id];
                return one(`select * from memories where id=? ${user_clause}`, p as any);
            }
        },
        get_mem_by_simhash: {
            get: (simhash, user_id) => {
                const user_clause = user_id ? "user_id = ?" : "1=1";
                const p = user_id ? [simhash, user_id] : [simhash];
                return one(`select * from memories where simhash=? and ${user_clause} order by salience desc limit 1`, p);
            }
        },
        get_active_users: {
            all: () =>
                many(
                    "select distinct user_id from memories where user_id is not null",
                ),
        },
        all_mem: {
            all: (limit, offset) =>
                many(
                    "select * from memories order by created_at desc limit ? offset ?",
                    [limit, offset],
                ),
        },
        all_mem_by_sector: {
            all: (sector, limit, offset, user_id) => {
                const user_clause = user_id ? "and user_id=?" : "";
                const p = user_id ? [sector, user_id, limit, offset] : [sector, limit, offset];
                return many(
                    `select * from memories where primary_sector=? ${user_clause} order by created_at desc limit ? offset ?`,
                    p,
                );
            },
        },
        get_training_data: {
            all: (user_id, limit) =>
                many(
                    `select primary_sector, mean_vec from memories where user_id=? and mean_vec is not null limit ?`,
                    [user_id, limit],
                ) as any,
        },
        get_segment_count: {
            get: (segment) =>
                one("select count(*) as c from memories where segment=?", [
                    segment,
                ]),
        },
        get_max_segment: {
            get: () =>
                one(
                    "select coalesce(max(segment), 0) as max_seg from memories",
                    [],
                ),
        },
        get_segments: {
            all: () =>
                many(
                    "select distinct segment from memories order by segment desc",
                    [],
                ),
        },
        get_mem_by_segment: {
            all: (segment) =>
                many(
                    "select * from memories where segment=? order by created_at desc",
                    [segment],
                ),
        },
        // Vector operations removed
        ins_waypoint: {
            run: (...p) =>
                exec_rowCount(
                    "insert or replace into waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?)",
                    p,
                ),
        },
        get_neighbors: {
            all: (src, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [src, user_id] : [src];
                return many(
                    `select dst_id,weight from waypoints where src_id=? ${user_clause} order by weight desc`,
                    p,
                );
            },
        },
        get_waypoints_by_src: {
            all: (src, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [src, user_id] : [src];
                return many(
                    `select src_id,dst_id,weight,created_at,updated_at from waypoints where src_id=? ${user_clause}`,
                    p,
                );
            },
        },
        get_waypoint: {
            get: (src, dst, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [src, dst, user_id] : [src, dst];
                return one(
                    `select weight from waypoints where src_id=? and dst_id=? ${user_clause}`,
                    p,
                );
            },
        },
        upd_waypoint: {
            run: (...p) => {
                // p: [src_id, weight, updated_at, dst_id, user_id]
                const user_id = p[4];
                const user_clause = user_id ? "and user_id = ?" : "";
                const params = user_id ? [p[1], p[2], p[0], p[3], user_id] : [p[1], p[2], p[0], p[3]];
                return exec_rowCount(
                    `update waypoints set weight=?,updated_at=? where src_id=? and dst_id=? ${user_clause}`,
                    params,
                );
            },
        },
        del_waypoints: {
            run: (...p) => {
                // p: [id, id, user_id]
                const user_id = p[2];
                const user_clause = user_id ? "and user_id = ?" : "";
                const params = user_id ? p : p.slice(0, 2);
                return exec_rowCount(`delete from waypoints where (src_id=? or dst_id=?) ${user_clause}`, params);
            },
        },
        prune_waypoints: {
            run: (t, user_id) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [t, user_id] : [t];
                return exec_rowCount(`delete from waypoints where weight<? ${user_clause}`, p);
            },
        },
        ins_log: {
            run: (...p) =>
                exec_rowCount(
                    "insert or replace into embed_logs(id,user_id,model,status,ts,err) values(?,?,?,?,?,?)",
                    p,
                ),
        },
        upd_log: {
            run: (...p) =>
                // p: [id, status, error]
                exec_rowCount("update embed_logs set status=?,err=? where id=?", [p[1], p[2], p[0]]),
        },
        get_pending_logs: {
            all: () =>
                many("select * from embed_logs where status=?", ["pending"]),
        },
        get_failed_logs: {
            all: () =>
                many(
                    "select * from embed_logs where status=? order by ts desc limit 100",
                    ["failed"],
                ),
        },
        all_mem_by_user: {
            all: (user_id, limit, offset) =>
                many(
                    "select * from memories where user_id=? order by created_at desc limit ? offset ?",
                    [user_id, limit, offset],
                ),
        },
        del_mem_by_user: {
            run: async (user_id: string) => {
                await exec_rowCount(`delete from ${sqlite_vector_table} where user_id=?`, [user_id]);
                await exec_rowCount(`delete from waypoints where user_id=?`, [user_id]);
                await exec_rowCount(`delete from temporal_facts where user_id=?`, [user_id]);
                await exec_rowCount(`delete from temporal_edges where user_id=?`, [user_id]);
                return await exec_rowCount("delete from memories where user_id=?", [user_id]);
            },
        },
        ins_user: {
            run: (...p) =>
                exec_rowCount(
                    "insert or ignore into users(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?)",
                    p,
                ),
        },
        get_user: {
            get: (user_id) =>
                one("select * from users where user_id=?", [user_id]),
        },
        upd_user_summary: {
            run: (...p) =>
                // p: [user_id, summary, updated_at]
                exec_rowCount(
                    "update users set summary=?,reflection_count=reflection_count+1,updated_at=? where user_id=?",
                    [p[1], p[2], p[0]],
                ),
        },
        clear_all: {
            run: async () => {
                await run_async(`delete from memories`);
                await run_async(`delete from waypoints`);
                await run_async(`delete from users`);
                await run_async(`delete from stats`);
                await run_async(`delete from temporal_facts`);
                await run_async(`delete from temporal_edges`);
                const vec_table = process.env.OM_VECTOR_TABLE || "vectors";
                await run_async(`delete from ${vec_table}`);
            },
        },
        get_mem_by_meta_like: {
            all: (pattern: string, user_id?: string) => {
                const user_clause = user_id ? "and user_id = ?" : "";
                const p = user_id ? [`%${pattern}%`, user_id] : [`%${pattern}%`];
                return many(
                    `select * from memories where meta like ? ${user_clause} order by created_at desc`,
                    p as any,
                );
            }
        },
        get_sector_stats: {
            all: (user_id) => {
                const user_clause = user_id ? "WHERE user_id = ?" : "WHERE user_id IS NULL";
                const p = user_id ? [user_id] : [];
                return many(
                    `select primary_sector as sector, count(*) as count, avg(salience) as avg_salience from memories ${user_clause} group by primary_sector`,
                    p,
                ) as Promise<SectorStat[]>;
            }
        },
    };
}

export const log_maint_op = async (
    type: "decay" | "reflect" | "consolidate",
    cnt = 1,
) => {
    try {
        const sql = is_pg
            ? `insert into "${process.env.OM_PG_SCHEMA || "public"}"."stats"(type,count,ts) values($1,$2,$3)`
            : "insert into stats(type,count,ts) values(?,?,?)";
        await run_async(sql, [type, cnt, Date.now()]);
    } catch (e) {
        console.error("[DB] Maintenance log error:", e);
    }
};

export { q, transaction, memories_table, vector_store };
