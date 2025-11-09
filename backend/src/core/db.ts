import { Database } from 'bun:sqlite'
import { Pool, PoolClient } from 'pg'
import { env } from './cfg'
import fs from 'node:fs'
import path from 'node:path'

type q_type = {
    ins_mem: { run: (...p: any[]) => Promise<void> }
    upd_mean_vec: { run: (...p: any[]) => Promise<void> }
    upd_compressed_vec: { run: (...p: any[]) => Promise<void> }
    upd_feedback: { run: (...p: any[]) => Promise<void> }
    upd_seen: { run: (...p: any[]) => Promise<void> }
    upd_mem: { run: (...p: any[]) => Promise<void> }
    upd_mem_with_sector: { run: (...p: any[]) => Promise<void> }
    /**
     * Delete a memory. This is a destructive operation and MUST be scoped to
     * a tenant via `user_id`. Callers must pass a non-null `user_id` or the
     * implementation will reject the call (throws) to avoid accidental
     * cross-tenant deletion.
     *
     * Inputs: (id, user_id)
     * Output: Promise<void>
     */
    del_mem: { run: (id: string, user_id: string) => Promise<void> }
    // memory getters accept an optional user_id; query will filter when provided
    get_mem: { get: (id: string, user_id?: string | null) => Promise<any> }
    get_mem_by_simhash: { get: (simhash: string, user_id?: string | null) => Promise<any> }
    all_mem: { all: (limit: number, offset: number, user_id?: string | null) => Promise<any[]> }
    all_mem_by_sector: { all: (sector: string, limit: number, offset: number, user_id?: string | null) => Promise<any[]> }
    all_mem_by_user: { all: (user_id: string, limit: number, offset: number) => Promise<any[]> }
    get_segment_count: { get: (segment: number, user_id?: string | null) => Promise<any> }
    get_max_segment: { get: () => Promise<any> }
    get_segments: { all: () => Promise<any[]> }
    get_mem_by_segment: { all: (segment: number, user_id?: string | null) => Promise<any[]> }
    ins_vec: { run: (...p: any[]) => Promise<void> }
    // vector getters support optional user_id scoping
    get_vec: { get: (id: string, sector: string, user_id?: string | null) => Promise<any> }
    get_vecs_by_id: { all: (id: string, user_id?: string | null) => Promise<any[]> }
    get_vecs_by_sector: { all: (sector: string, user_id?: string | null) => Promise<any[]> }
    get_vecs_batch: { all: (ids: string[], sector: string, user_id?: string | null) => Promise<any[]> }
    /**
     * Delete a vector. Requires a non-null `user_id` to avoid deleting other
     * tenants' vectors. Throws if `user_id` is falsy.
     */
    del_vec: { run: (id: string, user_id: string) => Promise<void> }
    /**
     * Delete vectors for an id/sector combination. Requires `user_id`.
     */
    del_vec_sector: { run: (id: string, sector: string, user_id: string) => Promise<void> }
    ins_waypoint: { run: (...p: any[]) => Promise<void> }
    // waypoint queries must accept user_id to scope
    get_neighbors: { all: (src: string, user_id?: string | null) => Promise<any[]> }
    get_waypoints_by_src: { all: (src: string, user_id?: string | null) => Promise<any[]> }
    get_waypoint: { get: (src: string, dst: string, user_id?: string | null) => Promise<any> }
    upd_waypoint: { run: (...p: any[]) => Promise<void> }
    del_waypoints: { run: (src_id: string, dst_id: string, user_id: string) => Promise<void> }
    del_waypoints_global: { run: (src_id: string, dst_id: string) => Promise<void> }
    prune_waypoints: { run: (threshold: number, user_id: string) => Promise<void> }
    prune_waypoints_global: { run: (threshold: number) => Promise<void> }
    ins_log: { run: (...p: any[]) => Promise<void> }
    upd_log: { run: (...p: any[]) => Promise<void> }
    get_pending_logs: { all: () => Promise<any[]> }
    get_failed_logs: { all: () => Promise<any[]> }
    ins_user: { run: (...p: any[]) => Promise<void> }
    get_user: { get: (user_id: string) => Promise<any> }
    upd_user_summary: { run: (...p: any[]) => Promise<void> }
    /**
     * Insert a maintenance/telemetry stat row. Signature: (type, count, ts, user_id?)
     * The `user_id` parameter is optional and may be `null` to indicate a
     * global stat. Use `q.ins_stat.run('reflect', 1, Date.now(), userId)` to
     * attach a stat to a user.
     */
    ins_stat: { run: (...p: any[]) => Promise<void> }
    /**
     * Update the summary column for a memory. Signature: (id, summary)
     */
    upd_summary: { run: (...p: any[]) => Promise<void> }
    count_memories: { get: () => Promise<any> }
    sector_counts: { all: () => Promise<any[]> }
    recent_memories_count: { get: (since: number) => Promise<any> }
    avg_salience: { get: () => Promise<any> }
    decay_stats: { get: () => Promise<any> }
    stats_range: { all: (type: string, since: number) => Promise<any[]> }
    // Per-user stats helpers
    /**
     * Return recent stat rows (count, ts) for a given type. Parameters:
     * (type, user_id|null, since). When user_id is null the query acts as
     * a global query.
     */
    stats_range_by_user: { all: (type: string, user_id: string | null, since: number) => Promise<any[]> }
    /**
     * Return a single-row count(*) result for the number of rows since `since`.
     * Signature: (type, user_id|null, since)
     */
    stats_count_since_by_user: { get: (type: string, user_id: string | null, since: number) => Promise<any> }
    stats_count_since: { get: (type: string, since: number) => Promise<any> }
    top_memories: { all: (limit: number) => Promise<any[]> }
    activities: { all: (limit: number) => Promise<any[]> }
    timeline_by_sector: { all: (since: number) => Promise<any[]> }
    /**
     * Per-user timeline summary grouped by sector and hour. Signature:
     * (user_id|null, since). When user_id is null this returns the global
     * timeline.
     */
    timeline_by_sector_by_user: { all: (user_id: string | null, since: number) => Promise<any[]> }
    maintenance_ops: { all: (since: number) => Promise<any[]> }
    /**
     * Per-user maintenance ops: returns aggregated counts grouped by hour.
     * Signature: (user_id|null, since)
     */
    maintenance_ops_by_user: { all: (user_id: string | null, since: number) => Promise<any[]> }
    totals_since: { all: (since: number) => Promise<any[]> }
    /**
     * Return summed `count` totals per type since `since`. Signature:
     * (user_id|null, since). When user_id is null returns global totals.
     */
    totals_since_by_user: { all: (user_id: string | null, since: number) => Promise<any[]> }
}

let run_async: (sql: string, p?: any[]) => Promise<void>
let get_async: (sql: string, p?: any[]) => Promise<any>
let all_async: (sql: string, p?: any[]) => Promise<any[]>
let transaction: { begin: () => Promise<void>; commit: () => Promise<void>; rollback: () => Promise<void> }
let q: q_type
let memories_table: string
// tx_info will be assigned per-backend (Postgres/SQLite) so callers can inspect
// current transaction/savepoint state for debugging.
let tx_info: () => any

const is_pg = env.metadata_backend === 'postgres'

if (is_pg) {
    const ssl = process.env.OM_PG_SSL === 'require' ? { rejectUnauthorized: false } : process.env.OM_PG_SSL === 'disable' ? false : undefined
    const db_name = process.env.OM_PG_DB || 'openmemory'
    const pool = (db: string) => new Pool({
        host: process.env.OM_PG_HOST,
        port: process.env.OM_PG_PORT ? +process.env.OM_PG_PORT : undefined,
        database: db,
        user: process.env.OM_PG_USER,
        password: process.env.OM_PG_PASSWORD,
        ssl
    })
    let pg = pool(db_name)
    let cli: PoolClient | null = null
    const sc = process.env.OM_PG_SCHEMA || 'public'
    const m = `"${sc}"."${process.env.OM_PG_TABLE || 'openmemory_memories'}"`
    memories_table = m
    const v = `"${sc}"."${process.env.OM_VECTOR_TABLE || 'openmemory_vectors'}"`
    const w = `"${sc}"."openmemory_waypoints"`
    const l = `"${sc}"."openmemory_embed_logs"`
    const f = `"${sc}"."openmemory_memories_fts"`
    const exec = async (sql: string, p: any[] = []) => {
        const c = cli || pg
        const start = Date.now()
        try {
            const res = await c.query(sql, p)
            if ((env as any).log_db) console.debug('[DB]', sql.split(/\s+/).slice(0, 6).join(' '), 'params=', p?.length || 0, 't=', Date.now() - start, 'ms')
            return res.rows
        } catch (err: any) {
            if ((env as any).log_db) console.error('[DB] ERR', sql.split(/\s+/).slice(0, 6).join(' '), err?.message || err)
            throw err
        }
    }
    run_async = async (sql, p = []) => { await exec(sql, p) }
    get_async = async (sql, p = []) => (await exec(sql, p))[0]
    all_async = async (sql, p = []) => await exec(sql, p)
    transaction = {
        // Support nested transactions using SAVEPOINTs. This allows callers to
        // call begin/commit/rollback in nested code paths without failing when a
        // transaction is already active. We maintain a savepoint stack per
        // connected client. Concurrent requests should still avoid sharing the
        // same client - this preserves previous semantics but enables nesting.
        begin: async () => {
            if (!cli) {
                cli = await pg.connect()
                    ; (cli as any).__om_tx_savepoints = [] as string[]
                if ((env as any).log_db) { console.log('[DB] PG: Transaction BEGIN (new client)') }
                await cli.query('BEGIN')
                return
            }
            // nested: create a savepoint
            const spName = `sp_${Date.now()}_${Math.floor(Math.random() * 100000)}`
            const stack = (cli as any).__om_tx_savepoints as string[]
            stack.push(spName)
            if ((env as any).log_db) { console.log('[DB] PG: SAVEPOINT', spName) }
            await cli.query(`SAVEPOINT ${spName}`)
        },
        commit: async () => {
            if (!cli) return
            const stack = (cli as any).__om_tx_savepoints as string[]
            if (stack && stack.length) {
                const sp = stack.pop() as string
                if ((env as any).log_db) { console.log('[DB] PG: RELEASE SAVEPOINT', sp) }
                await cli.query(`RELEASE SAVEPOINT ${sp}`)
                return
            }
            const t0 = Date.now()
            try {
                await cli.query('COMMIT')
                if ((env as any).log_db) console.debug('[DB] Transaction COMMIT t=', Date.now() - t0, 'ms')
            } finally {
                cli.release(); cli = null
            }
        },
        rollback: async () => {
            if (!cli) return
            const stack = (cli as any).__om_tx_savepoints as string[]
            if (stack && stack.length) {
                const sp = stack.pop() as string
                if ((env as any).log_db) { console.log('[DB] PG: ROLLBACK TO SAVEPOINT', sp) }
                await cli.query(`ROLLBACK TO SAVEPOINT ${sp}`)
                // after rollback to savepoint we release it to clean up
                await cli.query(`RELEASE SAVEPOINT ${sp}`)
                return
            }
            const t0 = Date.now()
            try {
                await cli.query('ROLLBACK')
                if ((env as any).log_db) console.debug('[DB] Transaction ROLLBACK t=', Date.now() - t0, 'ms')
            } finally {
                cli.release(); cli = null
            }
        }
    }
    tx_info = () => {
        // cli is in this closure when using Postgres
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client: any = cli
        return { backend: 'postgres', active: !!client, savepoints: client ? client.__om_tx_savepoints || [] : [] }
    }
    let ready = false
    const wait_ready = () => new Promise<void>(ok => {
        const check = () => ready ? ok() : setTimeout(check, 10)
        check()
    })
    const init = async () => {
        try {
            await pg.query('SELECT 1')
        } catch (err: any) {
            if (err.code === '3D000') {
                const admin = pool('postgres')
                try {
                    await admin.query(`CREATE DATABASE ${db_name}`)
                    console.log(`[DB] Created ${db_name}`)
                } catch (e: any) {
                    if (e.code !== '42P04') throw e
                } finally {
                    await admin.end()
                }
                pg = pool(db_name)
                await pg.query('SELECT 1')
            } else throw err
        }
        await pg.query(`create table if not exists ${m}(id uuid primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,summary text,created_at bigint,updated_at bigint,last_seen_at bigint,salience double precision,decay_lambda double precision,version integer default 1,mean_dim integer,mean_vec bytea,compressed_vec bytea,feedback_score double precision default 0)`)
        await pg.query(`create table if not exists ${v}(id uuid,sector text,user_id text,v bytea,dim integer not null,primary key(id,sector))`)
        await pg.query(`create table if not exists ${w}(src_id text,dst_id text not null,user_id text,weight double precision not null,created_at bigint,updated_at bigint,primary key(src_id,user_id))`)
        await pg.query(`create table if not exists ${l}(id text primary key,model text,status text,ts bigint,err text)`)
        await pg.query(`create table if not exists "${sc}"."openmemory_users"(user_id text primary key,summary text,reflection_count integer default 0,created_at bigint,updated_at bigint)`)
        await pg.query(`create index if not exists openmemory_memories_sector_idx on ${m}(primary_sector)`)
        await pg.query(`create index if not exists openmemory_memories_segment_idx on ${m}(segment)`)
        await pg.query(`create index if not exists openmemory_memories_simhash_idx on ${m}(simhash)`)
        await pg.query(`create index if not exists openmemory_memories_user_idx on ${m}(user_id)`)
        await pg.query(`create index if not exists openmemory_vectors_user_idx on ${v}(user_id)`)
        await pg.query(`create index if not exists openmemory_waypoints_user_idx on ${w}(user_id)`)
        // Ensure a stats table exists for maintenance/telemetry operations. Queries
        // in the code reference an unqualified "stats" table; we create it in the
        // configured schema so it's available via the default search_path (schema
        // defaults to 'public'). This mirrors the SQLite `stats` schema.
        await pg.query(`create table if not exists ${sc}."stats"(type text not null, count integer default 1, ts bigint not null, user_id text)`)
        await pg.query(`create index if not exists idx_stats_ts on ${sc}."stats"(ts)`)
        await pg.query(`create index if not exists idx_stats_type on ${sc}."stats"(type)`)
        await pg.query(`create index if not exists idx_stats_user_ts on ${sc}."stats"(user_id, ts)`)
        await pg.query(`create index if not exists idx_stats_user_type on ${sc}."stats"(user_id, type)`) 
        ready = true
    }
    init().catch(err => {
        console.error('[DB] Init failed:', err)
        process.exit(1)
    })
    const safe_exec = async (sql: string, p: any[] = []) => {
        await wait_ready()
        return exec(sql, p)
    }
    run_async = async (sql, p = []) => { await safe_exec(sql, p) }
    get_async = async (sql, p = []) => (await safe_exec(sql, p))[0]
    all_async = async (sql, p = []) => await safe_exec(sql, p)
    const clean = (s: string) => s ? s.replace(/"/g, '').replace(/\s+OR\s+/gi, ' OR ') : ''
    q = {
        ins_mem: { run: (...p) => run_async(`insert into ${m}(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) on conflict(id) do update set user_id=excluded.user_id,segment=excluded.segment,content=excluded.content,simhash=excluded.simhash,primary_sector=excluded.primary_sector,tags=excluded.tags,meta=excluded.meta,created_at=excluded.created_at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience,decay_lambda=excluded.decay_lambda,version=excluded.version,mean_dim=excluded.mean_dim,mean_vec=excluded.mean_vec,compressed_vec=excluded.compressed_vec,feedback_score=excluded.feedback_score`, p) },
        // Ensure PG updates accept an optional trailing user_id parameter and apply it in the WHERE clause
        upd_mean_vec: { run: (...p) => run_async(`update ${m} set mean_dim=$2,mean_vec=$3 where id=$1 and ($4 is null or user_id=$4)`, p) },
        upd_compressed_vec: { run: (...p) => run_async(`update ${m} set compressed_vec=$2 where id=$1 and ($3 is null or user_id=$3)`, p) },
        upd_feedback: { run: (...p) => run_async(`update ${m} set feedback_score=$2 where id=$1 and ($3 is null or user_id=$3)`, p) },
        upd_seen: { run: (...p) => run_async(`update ${m} set last_seen_at=$2,salience=$3,updated_at=$4 where id=$1 and ($5 is null or user_id=$5)`, p) },
        upd_mem: { run: (...p) => run_async(`update ${m} set content=$1,tags=$2,meta=$3,updated_at=$4,version=version+1 where id=$5 and ($6 is null or user_id=$6)`, p) },
        upd_mem_with_sector: { run: (...p) => run_async(`update ${m} set content=$1,primary_sector=$2,tags=$3,meta=$4,updated_at=$5,version=version+1 where id=$6 and ($7 is null or user_id=$7)`, p) },
        del_mem: { run: (id: string, user_id: string) => run_async(`delete from ${m} where id=$1 and user_id=$2`, [id, user_id]) },
        get_mem: {
            get: (id, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_mem')
                return get_async(`select * from ${m} where id=$1 and ($2 is null or user_id=$2)`, [id, user_id])
            }
        },
        get_mem_by_simhash: {
            get: (simhash, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_mem_by_simhash')
                return get_async(`select * from ${m} where simhash=$1 and ($2 is null or user_id=$2) order by salience desc limit 1`, [simhash, user_id])
            }
        },
        all_mem: {
            all: (limit, offset, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: all_mem')
                return all_async(`select * from ${m} where ($3 is null or user_id=$3) order by created_at desc limit $1 offset $2`, [limit, offset, user_id])
            }
        },
        all_mem_by_sector: {
            all: (sector, limit, offset, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: all_mem_by_sector')
                return all_async(`select * from ${m} where primary_sector=$1 and ($4 is null or user_id=$4) order by created_at desc limit $2 offset $3`, [sector, limit, offset, user_id])
            }
        },
        get_segment_count: {
            get: (segment, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_segment_count')
                return get_async(`select count(*) as c from ${m} where segment=$1 and ($2 is null or user_id=$2)`, [segment, user_id])
            }
        },
        get_max_segment: { get: () => get_async(`select coalesce(max(segment), 0) as max_seg from ${m}`, []) },
        get_segments: { all: () => all_async(`select distinct segment from ${m} order by segment desc`, []) },
        count_memories: { get: () => get_async(`select count(*) as count from ${m}`, []) },
        sector_counts: { all: () => all_async(`select primary_sector as sector, count(*) as count, avg(salience) as avg_salience from ${m} group by primary_sector`, []) },
        recent_memories_count: { get: (since) => get_async(`select count(*) as count from ${m} where created_at > $1`, [since]) },
        avg_salience: { get: () => get_async(`select avg(salience) as avg from ${m}`, []) },
        decay_stats: { get: () => get_async(`select count(*) as total, avg(decay_lambda) as avg_lambda, min(salience) as min_salience, max(salience) as max_salience from ${m}`, []) },
        stats_range: { all: (type, since) => all_async(`select count, ts FROM ${sc}."stats" WHERE type=$1 AND ts > $2 ORDER BY ts DESC`, [type, since]) },
        // per-user stats range: (type, user_id, since)
        stats_range_by_user: { all: (type, user_id, since) => all_async(`select count, ts FROM ${sc}."stats" WHERE type=$1 AND ts > $3 AND ($2 is null or user_id = $2) ORDER BY ts DESC`, [type, user_id, since]) },
        stats_count_since: { get: (type, since) => get_async(`select count(*) as total from ${sc}."stats" where type=$1 and ts > $2`, [type, since]) },
        stats_count_since_by_user: { get: (type, user_id, since) => get_async(`select count(*) as total from ${sc}."stats" where type=$1 and ts > $3 and ($2 is null or user_id = $2)`, [type, user_id, since]) },
        top_memories: { all: (limit) => all_async(`select id,content,primary_sector,salience,last_seen_at from ${m} order by salience desc limit $1`, [limit]) },
        activities: { all: (limit) => all_async(`select id,content,primary_sector,salience,created_at,updated_at,last_seen_at from ${m} order by updated_at desc limit $1`, [limit]) },
        // NOTE: timeline and maintenance ops are global (not scoped by user_id).
        // They summarize activity across all users. We also provide tenant-scoped
        // variants when callers need per-user summaries.
        timeline_by_sector: { all: (since) => all_async(`SELECT primary_sector, to_char(date_trunc('hour', to_timestamp(created_at/1000)), 'HH24:00') as hour, COUNT(*) as count FROM ${m} WHERE created_at > $1 GROUP BY primary_sector, hour ORDER BY hour`, [since]) },
        // Per-user timeline: (user_id, since)
        timeline_by_sector_by_user: { all: (user_id, since) => all_async(`SELECT primary_sector, to_char(date_trunc('hour', to_timestamp(created_at/1000)), 'HH24:00') as hour, COUNT(*) as count FROM ${m} WHERE created_at > $2 AND ($1 is null or user_id = $1) GROUP BY primary_sector, hour ORDER BY hour`, [user_id, since]) },
        maintenance_ops: { all: (since) => all_async(`SELECT type, to_char(date_trunc('hour', to_timestamp(ts/1000)), 'HH24:00') as hour, SUM(count) as cnt FROM ${sc}."stats" WHERE ts > $1 GROUP BY type, hour ORDER BY hour`, [since]) },
        // per-user maintenance ops: (user_id, since)
        maintenance_ops_by_user: { all: (user_id, since) => all_async(`SELECT type, to_char(date_trunc('hour', to_timestamp(ts/1000)), 'HH24:00') as hour, SUM(count) as cnt FROM ${sc}."stats" WHERE ts > $2 AND ($1 is null or user_id = $1) GROUP BY type, hour ORDER BY hour`, [user_id, since]) },
        totals_since: { all: (since) => all_async(`SELECT type, SUM(count) as total FROM ${sc}."stats" WHERE ts > $1 GROUP BY type`, [since]) },
        totals_since_by_user: { all: (user_id, since) => all_async(`SELECT type, SUM(count) as total FROM ${sc}."stats" WHERE ts > $2 AND ($1 is null or user_id = $1) GROUP BY type`, [user_id, since]) },
        get_mem_by_segment: {
            all: (segment, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_mem_by_segment')
                return all_async(`select * from ${m} where segment=$1 and ($2 is null or user_id=$2) order by created_at desc`, [segment, user_id])
            }
        },
        ins_vec: { run: (...p) => run_async(`insert into ${v}(id,sector,user_id,v,dim) values($1,$2,$3,$4,$5) on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim`, p) },
        get_vec: {
            get: (id, sector, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_vec')
                return get_async(`select v,dim from ${v} where id=$1 and sector=$2 and ($3 is null or user_id=$3)`, [id, sector, user_id])
            }
        },
        get_vecs_by_id: {
            all: (id, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_vecs_by_id')
                return all_async(`select sector,v,dim from ${v} where id=$1 and ($2 is null or user_id=$2)`, [id, user_id])
            }
        },
        get_vecs_by_sector: {
            all: (sector, user_id: string | null = null) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_vecs_by_sector')
                return all_async(`select id,v,dim from ${v} where sector=$1 and ($2 is null or user_id=$2)`, [sector, user_id])
            }
        },
        get_vecs_batch: {
            all: (ids: string[], sector: string, user_id: string | null = null) => {
                if (!ids.length) return Promise.resolve([])
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_vecs_batch')
                const ph = ids.map((_, i) => `$${i + 2}`).join(',')
                const uidIndex = ids.length + 2
                return all_async(`select id,v,dim from ${v} where sector=$1 and id in (${ph}) and ($${uidIndex} is null or user_id=$${uidIndex})`, [sector, ...ids, user_id])
            }
        },
        del_vec: { run: (id: string, user_id: string) => { if (!user_id) throw new Error('del_vec requires a non-null user_id'); return run_async(`delete from ${v} where id=$1 and user_id=$2`, [id, user_id]) } },
        del_vec_sector: { run: (id: string, sector: string, user_id: string) => { if (!user_id) throw new Error('del_vec_sector requires a non-null user_id'); return run_async(`delete from ${v} where id=$1 and sector=$2 and user_id=$3`, [id, sector, user_id]) } },
        ins_waypoint: { run: (...p) => { if (!p[2] && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: ins_waypoint'); return run_async(`insert into ${w}(src_id,dst_id,user_id,weight,created_at,updated_at) values($1,$2,$3,$4,$5,$6) on conflict(src_id,user_id) do update set dst_id=excluded.dst_id,weight=excluded.weight,updated_at=excluded.updated_at`, p) } },
        get_neighbors: { all: (src, user_id: string | null = null) => { if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_neighbors'); return all_async(`select dst_id,weight from ${w} where src_id=$1 and ($2 is null or user_id=$2) order by weight desc`, [src, user_id]) } },
        get_waypoints_by_src: { all: (src, user_id: string | null = null) => { if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_waypoints_by_src'); return all_async(`select src_id,dst_id,weight,created_at,updated_at from ${w} where src_id=$1 and ($2 is null or user_id=$2)`, [src, user_id]) } },
        get_waypoint: { get: (src, dst, user_id: string | null = null) => { if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: get_waypoint'); return get_async(`select weight from ${w} where src_id=$1 and dst_id=$2 and ($3 is null or user_id=$3)`, [src, dst, user_id]) } },
        upd_waypoint: { run: (weight: number, updated_at: number, src_id: string, dst_id: string, user_id: string | null = null) => { if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak in method: upd_waypoint'); return run_async(`update ${w} set weight=$1,updated_at=$2 where src_id=$3 and dst_id=$4 and ($5 is null or user_id=$5)`, [weight, updated_at, src_id, dst_id, user_id]) } },
        // destructive waypoint ops require explicit tenant scoping by default
        del_waypoints: {
            run: (src_id: string, dst_id: string, user_id: string | null = null) => {
                if (!user_id) throw new Error('Operation requires non-null user_id for tenant isolation')
                return run_async(`delete from ${w} where (src_id=$1 or dst_id=$2) and user_id=$3`, [src_id, dst_id, user_id])
            }
        },
        // global variant for admin/maintenance that explicitly allows cross-tenant deletes
        del_waypoints_global: { run: (src_id: string, dst_id: string) => run_async(`delete from ${w} where src_id=$1 or dst_id=$2`, [src_id, dst_id]) },
        prune_waypoints: {
            run: (t: number, user_id: string | null = null) => {
                if (!user_id) throw new Error('Operation requires non-null user_id for tenant isolation')
                return run_async(`delete from ${w} where weight<$1 and user_id=$2`, [t, user_id])
            }
        },
        prune_waypoints_global: { run: (t: number) => run_async(`delete from ${w} where weight<$1`, [t]) },

        ins_log: { run: (...p) => run_async(`insert into ${l}(id,model,status,ts,err) values($1,$2,$3,$4,$5) on conflict(id) do update set model=excluded.model,status=excluded.status,ts=excluded.ts,err=excluded.err`, p) },
        upd_log: { run: (...p) => run_async(`update ${l} set status=$2,err=$3 where id=$1`, p) },
        get_pending_logs: { all: () => all_async(`select * from ${l} where status=$1`, ['pending']) },
        get_failed_logs: { all: () => all_async(`select * from ${l} where status=$1 order by ts desc limit 100`, ['failed']) },
        all_mem_by_user: { all: (user_id, limit, offset) => all_async(`select * from ${m} where user_id=$1 order by created_at desc limit $2 offset $3`, [user_id, limit, offset]) },
        ins_user: { run: (...p) => run_async(`insert into "${sc}"."openmemory_users"(user_id,summary,reflection_count,created_at,updated_at) values($1,$2,$3,$4,$5) on conflict(user_id) do update set summary=excluded.summary,reflection_count=excluded.reflection_count,updated_at=excluded.updated_at`, p) },
        get_user: { get: (user_id) => get_async(`select * from "${sc}"."openmemory_users" where user_id=$1`, [user_id]) },
        upd_user_summary: { run: (...p: any[]) => run_async(`update "${sc}"."openmemory_users" set summary=$2,reflection_count=reflection_count+1,updated_at=$3 where user_id=$1`, p) },
        // ins_stat accepts optional user_id as the 4th parameter (nullable).
        ins_stat: { run: (...p: any[]) => run_async(`insert into ${sc}."stats"(type,count,ts,user_id) values($1,$2,$3,$4)`, p) },
        upd_summary: { run: (...p: any[]) => run_async(`update ${m} set summary=$2 where id=$1`, p) },
    }
} else {
    const db_path = env.db_path || './data/openmemory.sqlite'
    const dir = path.dirname(db_path)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const db = new Database(db_path)
    // Ensure the sqlite file has secure permissions on platforms that support it.
    // Wrap in try/catch to avoid failing on platforms where chmod may be unsupported
    // (CI runners or Windows shims). This enforces 0600 when possible.
    try {
        if (fs.existsSync(db_path)) {
            try {
                fs.chmodSync(db_path, 0o600)
                if ((env as any).log_db) console.debug('[DB] Set sqlite file permissions to 0600 for', db_path)
            } catch (e) {
                if ((env as any).log_db) console.warn('[DB] Unable to chmod sqlite file, continuing:', (e as any)?.message || e)
            }
        }
    } catch (e) {
        // If fs.existsSync itself fails for any reason, continue without blocking
        if ((env as any).log_db) console.warn('[DB] fs.existsSync threw when checking sqlite file, continuing:', (e as any)?.message || e)
    }
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=NORMAL')
    db.exec('PRAGMA temp_store=MEMORY')
    db.exec('PRAGMA cache_size=-8000')
    db.exec('PRAGMA mmap_size=134217728')
    db.exec('PRAGMA foreign_keys=OFF')
    db.exec('PRAGMA wal_autocheckpoint=20000')
    db.exec('PRAGMA locking_mode=EXCLUSIVE')
    db.exec('PRAGMA busy_timeout=50')
    db.exec(`create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,summary text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`)
    db.exec(`create table if not exists vectors(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`)
    db.exec(`create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,user_id))`)
    db.exec(`create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)`)
    db.exec(`create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`)
    db.exec(`create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null,user_id text)`) 
    db.exec('create index if not exists idx_memories_sector on memories(primary_sector)')
    db.exec('create index if not exists idx_memories_segment on memories(segment)')
    db.exec('create index if not exists idx_memories_simhash on memories(simhash)')
    db.exec('create index if not exists idx_memories_ts on memories(last_seen_at)')
    db.exec('create index if not exists idx_memories_user on memories(user_id)')
    db.exec('create index if not exists idx_vectors_user on vectors(user_id)')
    db.exec('create index if not exists idx_waypoints_src on waypoints(src_id)')
    db.exec('create index if not exists idx_waypoints_dst on waypoints(dst_id)')
    db.exec('create index if not exists idx_waypoints_user on waypoints(user_id)')
    db.exec('create index if not exists idx_stats_ts on stats(ts)')
    db.exec('create index if not exists idx_stats_type on stats(type)')
    db.exec('create index if not exists idx_stats_user_ts on stats(user_id, ts)')
    db.exec('create index if not exists idx_stats_user_type on stats(user_id, type)')
    memories_table = 'memories'
    // Use env.log_db (configured from OM_LOG_DB) for consistent logging flag
    const OM_LOG_DB = !!(env as any).log_db
    const summarize = (sql: string) => (sql || '').trim().split(/\s+/).slice(0, 6).join(' ')
    const exec = async (sql: string, p: any[] = []) => {
        const t0 = performance.now()
        try {
            db.run(sql, ...p)
            if ((env as any).log_db) console.debug('[DB]', summarize(sql), 'params=', p?.length || 0, 't=', (performance.now() - t0).toFixed(1), 'ms')
            return Promise.resolve()
        } catch (err: any) {
            if ((env as any).log_db) console.error('[DB] ERR', summarize(sql), err?.message || err)
            throw err
        }
    }
    const one = async (sql: string, p: any[] = []) => {
        const t0 = performance.now()
        try {
            const r = db.query(sql).get(...p)
            if ((env as any).log_db) console.debug('[DB]', summarize(sql), 'params=', p?.length || 0, 't=', (performance.now() - t0).toFixed(1), 'ms')
            return Promise.resolve(r)
        } catch (err: any) {
            if ((env as any).log_db) console.error('[DB] ERR', summarize(sql), err?.message || err)
            throw err
        }
    }
    const many = async (sql: string, p: any[] = []) => {
        const t0 = performance.now()
        try {
            const r = db.query(sql).all(...p)
            if ((env as any).log_db) console.debug('[DB]', summarize(sql), 'params=', p?.length || 0, 't=', (performance.now() - t0).toFixed(1), 'ms')
            return Promise.resolve(r)
        } catch (err: any) {
            if ((env as any).log_db) console.error('[DB] ERR', summarize(sql), err?.message || err)
            throw err
        }
    }
    run_async = exec
    get_async = one
    all_async = many
    // NOTE: We intentionally do NOT override Bun's sqlite `db.transaction`.
    // Instead we provide an explicit `withTransaction` helper (exported at
    // the bottom of this module) that callers should use to run code inside
    // a transaction/savepoint context. This keeps the Database prototype
    // untouched and provides consistent behavior across backends.
    // Support nested transactions in SQLite via SAVEPOINTs. We keep a savepoint
    // stack on the `db` object so nested begin/commit/rollback calls can be
    // safely managed. Top-level BEGIN/COMMIT/ROLLBACK are still used for the
    // first transaction.
    transaction = {
        begin: async () => {
            try {
                const stack = (db as any).__om_tx_savepoints || []
                if (!stack.length) {
                    try {
                        db.run('BEGIN')
                        if ((env as any).log_db) console.debug('[DB] SQLITE: BEGIN')
                    } catch (err: any) {
                        // If a transaction is already active outside our marker (e.g. some
                        // code invoked db.run('BEGIN') directly or another wrapper),
                        // fall back to creating a savepoint so we don't error.
                        if ((err && String(err.message).includes('cannot start a transaction within a transaction')) || (err && String(err).includes('cannot start a transaction within a transaction'))) {
                            const sp = `sp_${Date.now()}_${Math.floor(Math.random() * 100000)}`
                            db.run(`SAVEPOINT ${sp}`)
                            if ((env as any).log_db) console.debug('[DB] SQLITE: BEGIN fallback to SAVEPOINT', sp)
                            stack.push(sp)
                        } else {
                            throw err
                        }
                    }
                } else {
                    const sp = `sp_${Date.now()}_${Math.floor(Math.random() * 100000)}`
                    db.run(`SAVEPOINT ${sp}`)
                    if ((env as any).log_db) console.debug('[DB] SQLITE: SAVEPOINT', sp)
                    stack.push(sp)
                }
                (db as any).__om_tx_savepoints = stack
            } catch (e) {
                throw e
            }
        },
        commit: async () => {
            try {
                const stack = (db as any).__om_tx_savepoints || []
                if (stack.length) {
                    const sp = stack.pop() as string
                    db.run(`RELEASE SAVEPOINT ${sp}`)
                    if ((env as any).log_db) { console.log('[DB] SQLITE: RELEASE SAVEPOINT', sp) }
                    (db as any).__om_tx_savepoints = stack
                    return
                }
                db.run('COMMIT')
                if ((env as any).log_db) console.debug('[DB] SQLITE: COMMIT')
            } catch (e) {
                throw e
            }
        },
        rollback: async () => {
            try {
                const stack = (db as any).__om_tx_savepoints || []
                if (stack.length) {
                    const sp = stack.pop() as string
                    db.run(`ROLLBACK TO SAVEPOINT ${sp}`)
                    db.run(`RELEASE SAVEPOINT ${sp}`)
                    if ((env as any).log_db) { console.log('[DB] SQLITE: ROLLBACK TO/RELEASE SAVEPOINT', sp) }
                    (db as any).__om_tx_savepoints = stack
                    return
                }
                db.run('ROLLBACK')
                if ((env as any).log_db) console.debug('[DB] SQLITE: ROLLBACK')
            } catch (e) {
                throw e
            }
        }
    }

    // sqlite tx_info (captures db from closure scope)
    tx_info = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqliteDb: any = db
        return { backend: 'sqlite', active: !!(sqliteDb && (sqliteDb as any).__om_tx_savepoints && (sqliteDb as any).__om_tx_savepoints.length > 0), savepoints: (sqliteDb && (sqliteDb as any).__om_tx_savepoints) || [] }
    }

    const ins_mem_stmt = db.prepare('insert into memories(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set user_id=excluded.user_id,segment=excluded.segment,content=excluded.content,simhash=excluded.simhash,primary_sector=excluded.primary_sector,tags=excluded.tags,meta=excluded.meta,created_at=excluded.created_at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience,decay_lambda=excluded.decay_lambda,version=excluded.version,mean_dim=excluded.mean_dim,mean_vec=excluded.mean_vec,compressed_vec=excluded.compressed_vec,feedback_score=excluded.feedback_score')
    const upd_mean_vec_stmt = db.prepare('update memories set mean_dim=?,mean_vec=? where id=? and (? is null or user_id=?)')
    const upd_compressed_vec_stmt = db.prepare('update memories set compressed_vec=? where id=? and (? is null or user_id=?)')
    const upd_feedback_stmt = db.prepare('update memories set feedback_score=? where id=? and (? is null or user_id=?)')
    const upd_seen_stmt = db.prepare('update memories set last_seen_at=?,salience=?,updated_at=? where id=? and (? is null or user_id=?)')
    const upd_mem_stmt = db.prepare('update memories set content=?,tags=?,meta=?,updated_at=?,version=version+1 where id=? and (? is null or user_id=?)')
    const upd_mem_with_sector_stmt = db.prepare('update memories set content=?,primary_sector=?,tags=?,meta=?,updated_at=?,version=version+1 where id=? and (? is null or user_id=?)')
    const del_mem_stmt = db.prepare('delete from memories where id=? and user_id=?')
    const get_mem_stmt = db.prepare('select * from memories where id=? and (? is null or user_id=?)')
    const get_mem_by_simhash_stmt = db.prepare('select * from memories where simhash=? and (? is null or user_id=?) order by salience desc limit 1')
    const all_mem_stmt = db.prepare('select * from memories where (? is null or user_id=?) order by created_at desc limit ? offset ?')
    const all_mem_by_sector_stmt = db.prepare('select * from memories where primary_sector=? and (? is null or user_id=?) order by created_at desc limit ? offset ?')
    const get_segment_count_stmt = db.prepare('select count(*) as c from memories where segment=? and (? is null or user_id=?)')
    const get_max_segment_stmt = db.prepare('select coalesce(max(segment), 0) as max_seg from memories')
    const get_segments_stmt = db.prepare('select distinct segment from memories order by segment desc')
    const get_mem_by_segment_stmt = db.prepare('select * from memories where segment=? and (? is null or user_id=?) order by created_at desc')
    const ins_vec_stmt = db.prepare('insert into vectors(id,sector,user_id,v,dim) values(?,?,?,?,?) on conflict(id,sector) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim')
    const get_vec_stmt = db.prepare('select v,dim from vectors where id=? and sector=? and (? is null or user_id=?)')
    const get_vecs_by_id_stmt = db.prepare('select sector,v,dim from vectors where id=? and (? is null or user_id=?)')
    const get_vecs_by_sector_stmt = db.prepare('select id,v,dim from vectors where sector=? and (? is null or user_id=?)')
    const get_vecs_batch_cache = new Map<number, any>()
    const del_vec_stmt = db.prepare('delete from vectors where id=? and user_id=?')
    const del_vec_sector_stmt = db.prepare('delete from vectors where id=? and sector=? and user_id=?')
    const ins_waypoint_stmt = db.prepare('insert or replace into waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?)')
    const get_neighbors_stmt = db.prepare('select dst_id,weight from waypoints where src_id=? and (? is null or user_id=?) order by weight desc')
    const get_waypoints_by_src_stmt = db.prepare('select src_id,dst_id,weight,created_at,updated_at from waypoints where src_id=? and (? is null or user_id=?)')
    const get_waypoint_stmt = db.prepare('select weight from waypoints where src_id=? and dst_id=? and (? is null or user_id=?)')
    const upd_waypoint_stmt = db.prepare('update waypoints set weight=?,updated_at=? where src_id=? and dst_id=? and (? is null or user_id=?)')
    const del_waypoints_stmt = db.prepare('delete from waypoints where (src_id=? or dst_id=?) and user_id=?')
    const del_waypoints_global_stmt = db.prepare('delete from waypoints where src_id=? or dst_id=?')
    const prune_waypoints_stmt = db.prepare('delete from waypoints where weight<? and user_id=?')
    const prune_waypoints_global_stmt = db.prepare('delete from waypoints where weight<?')
    const ins_log_stmt = db.prepare('insert or replace into embed_logs(id,model,status,ts,err) values(?,?,?,?,?)')
    const upd_log_stmt = db.prepare('update embed_logs set status=?,err=? where id=?')
    const get_pending_logs_stmt = db.prepare('select * from embed_logs where status=?')
    const get_failed_logs_stmt = db.prepare('select * from embed_logs where status=? order by ts desc limit 100')
    const all_mem_by_user_stmt = db.prepare('select * from memories where user_id=? order by created_at desc limit ? offset ?')
    const ins_user_stmt = db.prepare('insert or replace into users(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?)')
    const get_user_stmt = db.prepare('select * from users where user_id=?')
    const upd_user_summary_stmt = db.prepare('update users set summary=?,reflection_count=reflection_count+1,updated_at=? where user_id=?')
    const count_memories_stmt = db.prepare('select count(*) as count from memories')
    const sector_counts_stmt = db.prepare('select primary_sector as sector, count(*) as count, avg(salience) as avg_salience from memories group by primary_sector')
    const recent_memories_count_stmt = db.prepare('select count(*) as count from memories where created_at > ?')
    const avg_salience_stmt = db.prepare('select avg(salience) as avg from memories')
    const decay_stats_stmt = db.prepare('select count(*) as total, avg(decay_lambda) as avg_lambda, min(salience) as min_salience, max(salience) as max_salience from memories')
    const stats_range_stmt = db.prepare('select count, ts from stats where type=? and ts>? order by ts desc')
    const stats_count_since_stmt = db.prepare('select count(*) as total from stats where type=? and ts>?')
    const stats_range_by_user_stmt = db.prepare('select count, ts from stats where type=? and ts>? and (? is null or user_id=?) order by ts desc')
    const stats_count_since_by_user_stmt = db.prepare('select count(*) as total from stats where type=? and ts>? and (? is null or user_id=?)')
    const top_memories_stmt = db.prepare('select id,content,primary_sector,salience,last_seen_at from memories order by salience desc limit ?')
    const activities_stmt = db.prepare('select id,content,primary_sector,salience,created_at,updated_at,last_seen_at from memories order by updated_at desc limit ?')
    // timeline and maintenance ops are global summaries (not tenant-scoped).
    // If tenant-scoped variants are required, add *_by_user helpers.
    const timeline_stmt = db.prepare("SELECT primary_sector, strftime('%H:00', datetime(created_at/1000, 'unixepoch')) as hour, COUNT(*) as count FROM memories WHERE created_at > ? GROUP BY primary_sector, hour ORDER BY hour")
    const timeline_by_sector_by_user_stmt = db.prepare("SELECT primary_sector, strftime('%H:00', datetime(created_at/1000, 'unixepoch')) as hour, COUNT(*) as count FROM memories WHERE created_at > ? AND (? is null or user_id=?) GROUP BY primary_sector, hour ORDER BY hour")
    const maintenance_ops_stmt = db.prepare("SELECT type, strftime('%H:00', datetime(ts/1000, 'unixepoch', 'localtime')) as hour, SUM(count) as cnt FROM stats WHERE ts > ? GROUP BY type, hour ORDER BY hour")
    const maintenance_ops_by_user_stmt = db.prepare("SELECT type, strftime('%H:00', datetime(ts/1000, 'unixepoch', 'localtime')) as hour, SUM(count) as cnt FROM stats WHERE ts > ? AND (? is null or user_id=?) GROUP BY type, hour ORDER BY hour")
    const totals_since_stmt = db.prepare('SELECT type, SUM(count) as total FROM stats WHERE ts > ? GROUP BY type')
    const totals_since_by_user_stmt = db.prepare('SELECT type, SUM(count) as total FROM stats WHERE ts > ? AND (? is null or user_id=?) GROUP BY type')

    q = {
        ins_mem: { run: (...p) => { ins_mem_stmt.run(...p); return Promise.resolve() } },
        // sqlite prepared statements expect parameters in a slightly different order / duplication for NULL checks
        upd_mean_vec: { run: (id: string, mean_dim: number, mean_vec: any, user_id: string | null = null) => { upd_mean_vec_stmt.run(mean_dim, mean_vec, id, user_id, user_id); return Promise.resolve() } },
        upd_compressed_vec: { run: (id: string, compressed_vec: any, user_id: string | null = null) => { upd_compressed_vec_stmt.run(compressed_vec, id, user_id, user_id); return Promise.resolve() } },
        upd_feedback: { run: (id: string, feedback: number, user_id: string | null = null) => { upd_feedback_stmt.run(feedback, id, user_id, user_id); return Promise.resolve() } },
        upd_seen: { run: (id: string, last_seen_at: number, salience: number, updated_at: number, user_id: string | null = null) => { upd_seen_stmt.run(last_seen_at, salience, updated_at, id, user_id, user_id); return Promise.resolve() } },
        upd_mem: { run: (content: string, tags: any, meta: any, updated_at: number, id: string, user_id: string | null = null) => { upd_mem_stmt.run(content, tags, meta, updated_at, id, user_id, user_id); return Promise.resolve() } },
        upd_mem_with_sector: { run: (content: string, primary_sector: string, tags: any, meta: any, updated_at: number, id: string, user_id: string | null = null) => { upd_mem_with_sector_stmt.run(content, primary_sector, tags, meta, updated_at, id, user_id, user_id); return Promise.resolve() } },
        del_mem: { run: (id, user_id) => { del_mem_stmt.run(id, user_id); return Promise.resolve() } },
        get_mem: { get: (id, user_id = null) => Promise.resolve(get_mem_stmt.get(id, user_id, user_id)) },
        get_mem_by_simhash: { get: (simhash, user_id = null) => Promise.resolve(get_mem_by_simhash_stmt.get(simhash, user_id, user_id)) },
        all_mem: { all: (limit, offset, user_id = null) => Promise.resolve(all_mem_stmt.all(user_id, user_id, limit, offset)) },
        all_mem_by_sector: { all: (sector, limit, offset, user_id = null) => Promise.resolve(all_mem_by_sector_stmt.all(sector, user_id, user_id, limit, offset)) },
        get_segment_count: { get: (segment, user_id = null) => Promise.resolve(get_segment_count_stmt.get(segment, user_id, user_id)) },
        get_max_segment: { get: () => Promise.resolve(get_max_segment_stmt.get()) },
        get_segments: { all: () => Promise.resolve(get_segments_stmt.all()) },
        get_mem_by_segment: { all: (segment, user_id = null) => Promise.resolve(get_mem_by_segment_stmt.all(segment, user_id, user_id)) },
        ins_vec: { run: (...p) => { ins_vec_stmt.run(...p); return Promise.resolve() } },
        get_vec: {
            get: (id, sector, user_id = null) => {
                return Promise.resolve(get_vec_stmt.get(id, sector, user_id, user_id))
            }
        },
        get_vecs_by_id: { all: (id, user_id = null) => Promise.resolve(get_vecs_by_id_stmt.all(id, user_id, user_id)) },
        get_vecs_by_sector: { all: (sector, user_id = null) => Promise.resolve(get_vecs_by_sector_stmt.all(sector, user_id, user_id)) },
        get_vecs_batch: {
            all: (ids: string[], sector: string, user_id = null) => {
                if (!ids.length) return Promise.resolve([])
                const key = ids.length
                let stmt = get_vecs_batch_cache.get(key)
                if (!stmt) {
                    const idClauses = ids.map(() => 'id=?').join(' or ')
                    stmt = db.prepare(`select id,v,dim from vectors where sector=? and (${idClauses}) and (? is null or user_id=?)`)
                    get_vecs_batch_cache.set(key, stmt)
                }
                return Promise.resolve(stmt.all(sector, ...ids, user_id, user_id))
            }
        },
        // Destructive vector deletes require explicit non-null user_id in SQLite as well
        // Return a rejected Promise when user_id is falsy so callers can use
        // `await expect(q.del_vec.run(...)).rejects` in tests instead of catching
        // a synchronous throw.
        del_vec: { run: (id: string, user_id: string) => { if (!user_id) return Promise.reject(new Error('del_vec requires a non-null user_id')); del_vec_stmt.run(id, user_id); return Promise.resolve() } },
        del_vec_sector: { run: (id: string, sector: string, user_id: string) => { if (!user_id) return Promise.reject(new Error('del_vec_sector requires a non-null user_id')); del_vec_sector_stmt.run(id, sector, user_id); return Promise.resolve() } },
        ins_waypoint: {
            run: (...p) => {
                if (!p[2] && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak')
                ins_waypoint_stmt.run(...p); return Promise.resolve()
            }
        },
        get_neighbors: {
            all: (src, user_id = null) => {
                return Promise.resolve(get_neighbors_stmt.all(src, user_id, user_id))
            }
        },
        get_waypoints_by_src: { all: (src, user_id = null) => Promise.resolve(get_waypoints_by_src_stmt.all(src, user_id, user_id)) },
        get_waypoint: { get: (src, dst, user_id = null) => Promise.resolve(get_waypoint_stmt.get(src, dst, user_id, user_id)) },
        upd_waypoint: { run: (weight: number, updated_at: number, src_id: string, dst_id: string, user_id: string | null = null) => { upd_waypoint_stmt.run(weight, updated_at, src_id, dst_id, user_id, user_id); return Promise.resolve() } },
        del_waypoints: { run: (src_id: string, dst_id: string, user_id: string) => { if (!user_id) return Promise.reject(new Error('Operation requires non-null user_id for tenant isolation')); del_waypoints_stmt.run(src_id, dst_id, user_id); return Promise.resolve() } },
        del_waypoints_global: { run: (src_id: string, dst_id: string) => { del_waypoints_global_stmt.run(src_id, dst_id); return Promise.resolve() } },
        prune_waypoints: { run: (t: number, user_id: string) => { if (!user_id) return Promise.reject(new Error('Operation requires non-null user_id for tenant isolation')); prune_waypoints_stmt.run(t, user_id); return Promise.resolve() } },
        prune_waypoints_global: { run: (t: number) => { prune_waypoints_global_stmt.run(t); return Promise.resolve() } },
        ins_log: { run: (...p) => { ins_log_stmt.run(...p); return Promise.resolve() } },
        upd_log: { run: (...p) => { upd_log_stmt.run(...p); return Promise.resolve() } },
        get_pending_logs: { all: () => Promise.resolve(get_pending_logs_stmt.all('pending')) },
        get_failed_logs: { all: () => Promise.resolve(get_failed_logs_stmt.all('failed')) },
        all_mem_by_user: {
            all: (user_id, limit, offset) => {
                if (!user_id && (env as any).log_tenant) console.warn('[DB] Query without user_id - potential cross-tenant leak')
                return Promise.resolve(all_mem_by_user_stmt.all(user_id, limit, offset))
            }
        },
        ins_user: { run: (...p) => { ins_user_stmt.run(...p); return Promise.resolve() } },
        get_user: { get: (user_id) => Promise.resolve(get_user_stmt.get(user_id)) },
        upd_user_summary: { run: (...p) => { upd_user_summary_stmt.run(...p); return Promise.resolve() } },
        // ins_stat accepts optional user_id as the 4th parameter (nullable).
        // Ensure sqlite gets four parameters (pass null for missing user_id).
        ins_stat: {
            run: (...p: any[]) => {
                const args = p.slice(0, 4)
                while (args.length < 4) args.push(null)
                return exec('insert into stats(type,count,ts,user_id) values(?,?,?,?)', args)
            }
        },
        upd_summary: { run: (id: string, summary: string) => exec('update memories set summary=? where id=?', [summary, id]) },
        count_memories: { get: () => Promise.resolve(count_memories_stmt.get()) },
        sector_counts: { all: () => Promise.resolve(sector_counts_stmt.all()) },
        recent_memories_count: { get: (since: number) => Promise.resolve(recent_memories_count_stmt.get(since)) },
        avg_salience: { get: () => Promise.resolve(avg_salience_stmt.get()) },
        decay_stats: { get: () => Promise.resolve(decay_stats_stmt.get()) },
        stats_range: { all: (type: string, since: number) => Promise.resolve(stats_range_stmt.all(type, since)) },
        // Per-user variants: (type, user_id, since)
        stats_range_by_user: { all: (type: string, user_id: string | null = null, since: number) => Promise.resolve(stats_range_by_user_stmt.all(type, since, user_id, user_id)) },
        stats_count_since: { get: (type: string, since: number) => Promise.resolve(stats_count_since_stmt.get(type, since)) },
        stats_count_since_by_user: { get: (type: string, user_id: string | null = null, since: number) => Promise.resolve(stats_count_since_by_user_stmt.get(type, since, user_id, user_id)) },
        top_memories: { all: (limit: number) => Promise.resolve(top_memories_stmt.all(limit)) },
        activities: { all: (limit: number) => Promise.resolve(activities_stmt.all(limit)) },
        timeline_by_sector: { all: (since: number) => Promise.resolve(timeline_stmt.all(since)) },
        // Per-user timeline: (user_id, since)
        timeline_by_sector_by_user: { all: (user_id: string | null = null, since: number) => Promise.resolve(timeline_by_sector_by_user_stmt.all(since, user_id, user_id)) },
        maintenance_ops: { all: (since: number) => Promise.resolve(maintenance_ops_stmt.all(since)) },
        maintenance_ops_by_user: { all: (user_id: string | null = null, since: number) => Promise.resolve(maintenance_ops_by_user_stmt.all(since, user_id, user_id)) },
        totals_since: { all: (since: number) => Promise.resolve(totals_since_stmt.all(since)) },
        totals_since_by_user: { all: (user_id: string | null = null, since: number) => Promise.resolve(totals_since_by_user_stmt.all(since, user_id, user_id)) }
    }
}

export const log_maint_op = async (type: 'decay' | 'reflect' | 'consolidate', cnt = 1) => {
    try {
        // Use the q helper so both SQLite and Postgres backends get the correct
        // parameter binding and any logging applied by the q layer.
        await q.ins_stat.run(type, cnt, Date.now())
    } catch (e) {
        console.error('[DB] Maintenance log error:', e)
    }
}
/**
 * Run a function inside a transaction (supports nested savepoints).
 * The helper uses the backend-specific `transaction` handlers defined above.
 *
 * Example:
 * ```ts
 * // atomically insert a stat; will be committed when the function completes
 * await withTransaction(async () => {
 *   await q.ins_stat.run('example', 1, Date.now())
 * })
 *
 * // rollback example (throwing inside the function will rollback)
 * try {
 *   await withTransaction(async () => {
 *     await q.ins_stat.run('will_roll', 1, Date.now())
 *     throw new Error('force rollback')
 *   })
 * } catch (e) {
 *   // the 'will_roll' stat is not committed
 * }
 * ```
 */
export const withTransaction = async <T>(fn: () => Promise<T> | T) => {
    await transaction.begin()
    try {
        const r = await fn()
        await transaction.commit()
        return r
    } catch (e) {
        await transaction.rollback()
        throw e
    }
}

export { q, transaction, all_async, get_async, run_async, memories_table, tx_info }
