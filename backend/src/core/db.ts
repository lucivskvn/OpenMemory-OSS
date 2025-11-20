import { env } from "./cfg";
import fs from "node:fs";
import path from "node:path";
import logger from "./logger";
import { createSQLiteDatabase, detectSQLiteCapabilities } from "./sqlite-runtime";

/**
 * Typed q helper signatures
 *
 * We prefer explicit parameter lists for the common call-shapes used by
 * application code. Legacy, backward-compatible call shapes (omitting a
 * trailing `user_id`) are supported at runtime but are considered
 * deprecated for application code when `OM_STRICT_TENANT=true` is used.
 */
type RunIdUserOptional = { run: (id: string, user_id?: string | null) => Promise<void> };
type RunIdSectorUserOptional = { run: (id: string, sector: string, user_id?: string | null) => Promise<void> };
type RunIdUserOptionalGeneric = { run: (id: string, ...rest: any[]) => Promise<void> };

type q_type = {
    // Complex/variable signature: keep flexible for existing callers
    ins_mem: { run: (...p: any[]) => Promise<void> };
    // Prefer normalized signatures for vector/mean updates used by apps
    upd_mean_vec: { run: (id: string, mean_dim: number, mean_vec: Buffer | Uint8Array | any, user_id?: string | null) => Promise<void> };
    upd_compressed_vec: { run: (id: string, compressed_vec: Buffer | Uint8Array | any, user_id?: string | null) => Promise<void> };
    upd_feedback: { run: (id: string, feedback_score: number, user_id?: string | null) => Promise<void> };
    upd_seen: { run: (id: string, last_seen_at: number, salience: number, updated_at: number, user_id?: string | null) => Promise<void> };
    upd_mem: { run: (content: string, tags: string, meta: string, updated_at: number, id: string, user_id?: string | null) => Promise<void> };
    upd_mem_with_sector: { run: (content: string, primary_sector: string, tags: string, meta: string, updated_at: number, id: string, user_id?: string | null) => Promise<void> };
    del_mem: { run: (id: string, user_id?: string | null) => Promise<void> };
    get_mem: { get: (id: string, user_id?: string | null) => Promise<any> };
    get_mem_by_simhash: { get: (simhash: string, user_id?: string | null) => Promise<any> };
    all_mem: { all: (limit: number, offset: number, user_id?: string | null) => Promise<any[]> };
    all_mem_by_sector: {
        all: (sector: string, limit: number, offset: number, user_id?: string | null) => Promise<any[]>;
    };
    all_mem_by_user: {
        all: (user_id: string, limit: number, offset: number) => Promise<any[]>;
    };
    all_mem_by_user_and_sector: {
        all: (user_id: string, sector: string, limit: number, offset: number) => Promise<any[]>;
    };
    get_segment_count: { get: (segment: number) => Promise<any> };
    get_max_segment: { get: () => Promise<any> };
    get_segments: { all: () => Promise<any[]> };
    get_mem_by_segment: { all: (segment: number) => Promise<any[]> };
    ins_vec: { run: (...p: any[]) => Promise<void> };
    get_vec: { get: (id: string, sector: string, user_id?: string | null) => Promise<any> };
    get_vecs_by_id: { all: (id: string, user_id?: string | null) => Promise<any[]> };
    get_vecs_by_sector: { all: (sector: string, user_id?: string | null) => Promise<any[]> };
    get_vecs_batch: { all: (ids: string[], sector: string, user_id?: string | null) => Promise<any[]> };
    del_vec: { run: (...p: any[]) => Promise<void> };
    del_vec_sector: { run: (...p: any[]) => Promise<void> };
    ins_waypoint: { run: (...p: any[]) => Promise<void> };
    get_neighbors: { all: (src: string, user_id?: string | null) => Promise<any[]> };
    get_waypoints_by_src: { all: (src: string, user_id?: string | null) => Promise<any[]> };
    get_waypoint: { get: (src: string, dst: string, user_id?: string | null) => Promise<any> };
    upd_waypoint: { run: (...p: any[]) => Promise<void> };
    del_waypoints: { run: (...p: any[]) => Promise<void> };
    prune_waypoints: { run: (threshold: number) => Promise<void> };
    ins_log: { run: (...p: any[]) => Promise<void> };
    upd_log: { run: (...p: any[]) => Promise<void> };
    get_pending_logs: { all: () => Promise<any[]> };
    get_failed_logs: { all: () => Promise<any[]> };
    get_stream_telemetry: { all: (limit?: number, offset?: number) => Promise<any[]> };
    ins_user: { run: (...p: any[]) => Promise<void> };
    get_user: { get: (user_id: string) => Promise<any> };
    upd_user_summary: { run: (...p: any[]) => Promise<void> };
    ins_stream_telemetry: { run: (id: string, user_id: string | null, embedding_mode: string | null, duration_ms: number, memory_ids: string, query: string, ts: number) => Promise<void> };
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
let memories_table: string;
// Guard to ensure initDb() is idempotent across imports/calls
let _initialized_db_path: string | null = null;
// Track underlying DB clients so tests and callers can cleanly close them.
let _pgClient: any = null;
let _pgPool: any = null;
let _sqliteDb: any = null; // Cross-runtime SQLite instance

/**
 * Sanitize connection string for logging by masking password without revealing raw credentials.
 */
function sanitizeConnectionString(connStr: string): string {
    try {
        const url = new URL(connStr);
        url.password = '***';
        return url.toString();
    } catch {
        // If URL parsing fails, mark as invalid without logging raw string
        return '(invalid connection string - not parseable as URL)';
    }
}

/**
 * parsePgConnectionString: Parses a libpq-style PostgreSQL connection string (OM_PG_CONNECTION_STRING).
 * Returns an options object with host, port, database, user, password, ssl, and logger warning if invalid.
 * Note: malformed URIs (including empty hostnames or unsupported socket-style `host=/path/to/socket` patterns)
 * cause the function to return an empty options object, and initDb() then falls back to discrete OM_PG_*
 * environment variables.
 */
export function parsePgConnectionString(connStr: string | undefined, logger: any): any {
    let opts: any = {};
    if (connStr) {
        try {
            // Subset implementation: supports only simple host:port/database URIs; does not support libpq socket or multi-host forms
            const u = new URL(connStr);
            // Check for multi-host libpq URIs (unsupported)
            if (u.hostname.includes(',')) {
                logger.warn({ component: 'DB', connection_string: sanitizeConnectionString(connStr) }, '[DB] Multi-host libpq URIs are unsupported; comma-separated hostnames are not supported. The connection string is being ignored and discrete OM_PG_* variables will be used instead. Falling back to OM_PG_HOST, OM_PG_PORT, OM_PG_DB, OM_PG_USER, and OM_PG_PASSWORD');
                return {};
            }
            // Check for unexpected query parameters (only sslmode and host are honored)
            const params = Array.from(u.searchParams.keys());
            if (params.some(p => p !== 'sslmode' && p !== 'host')) {
                logger.warn({ component: 'DB', connection_string: sanitizeConnectionString(connStr) }, '[DB] Additional query string parameters are ignored; only sslmode and host are honored, others are not supported');
            }
            // Optionally detect socket-style URIs (host=/path/to/socket)
            const hostParam = u.searchParams.get('host');
            if (hostParam && hostParam.startsWith('/')) {
                logger.warn({ component: 'DB', connection_string: sanitizeConnectionString(connStr) }, '[DB] Socket-style URIs are unsupported; host=/path/to/socket patterns are not supported. The connection string is being ignored and discrete OM_PG_* variables will be used instead. Falling back to OM_PG_HOST, OM_PG_PORT, OM_PG_DB, OM_PG_USER, and OM_PG_PASSWORD');
                return {};
            }
            opts.host = u.hostname;
            opts.port = u.port ? +u.port : undefined;
            // URL pathname: split on '/', filter empty parts, take last segment for database name
            opts.database = u.pathname ? u.pathname.split('/').filter(part => part.length > 0).pop() : undefined;
            if (u.username) opts.user = decodeURIComponent(u.username);
            if (u.password) opts.password = decodeURIComponent(u.password);
            // libpq-style sslmode in query string (disable | require | verify-full)
            const sslmode = u.searchParams.get('sslmode');
            if (sslmode === 'require') opts.ssl = { rejectUnauthorized: false };
            else if (sslmode === 'disable') opts.ssl = false;
            else if (sslmode === 'verify-full') opts.ssl = { rejectUnauthorized: true };

            // Validate URL scheme
            if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
                logger.warn({ component: 'DB', connection_string: sanitizeConnectionString(connStr) }, '[DB] Invalid protocol in OM_PG_CONNECTION_STRING; only postgres:// or postgresql:// are supported, falling back to individual OM_PG_* env vars');
                return {};
            }

            // Sanity check for required fields
            if (!opts.database) {
                logger.warn({ component: 'DB', connection_string: sanitizeConnectionString(connStr) }, '[DB] Incomplete connection string in OM_PG_CONNECTION_STRING; missing database, falling back to individual OM_PG_* env vars');
                return {};
            }
        } catch (e) {
            // If the connection string is malformed, fail silently and fall back
            // to discrete env vars. Avoid noisy logs in test environments to
            // keep behavior deterministic for unit tests that validate fallbacks.
            return {};
        }
    }
    return opts;
}

/**
 * Helper: warnIfMissingUserId
 * Centralize the user-scope warning heuristic used by both Postgres and SQLite
 * query wrappers. When `OM_DB_USER_SCOPE_WARN=true` and the SQL contains
 * `user_id` references, attempt to parse parameter positions and warn if the
 * detected parameter slots are null/empty. Respects `OM_DB_DEBUG_USER_SCOPE`
 * to enable noisier fallback heuristics.
 */
function warnIfMissingUserId(sql: string, p: any[] = []) {
    try {
        if (process.env.OM_DB_USER_SCOPE_WARN !== "true") return;
        if (!/user_id/.test(sql)) return;

        const userIdIndexes: number[] = [];
        const debugFallback = (process.env.OM_DB_DEBUG_USER_SCOPE || "false") === "true";

        // Postgres-style placeholders: user_id=$N
        const pgRe = /user_id\s*=\s*\$(\d+)/gi;
        let m: RegExpExecArray | null;
        while ((m = pgRe.exec(sql))) {
            const idx = parseInt(m[1], 10) - 1;
            if (!Number.isNaN(idx)) userIdIndexes.push(idx);
        }

        // SQLite-style placeholders: user_id=? ; count question marks before occurrence
        const sqliteRe = /user_id\s*=\s*\?/gi;
        while ((m = sqliteRe.exec(sql))) {
            const pos = m.index;
            const snippet = sql.slice(0, pos + 1);
            const qCount = (snippet.match(/\?/g) || []).length;
            const idx = Math.max(0, qCount - 1);
            userIdIndexes.push(idx);
        }

        let shouldWarn = false;
        if (userIdIndexes.length > 0 && Array.isArray(p)) {
            for (const i of userIdIndexes) {
                const val = p[i];
                if (val === null || val === undefined || val === "") {
                    shouldWarn = true;
                    break;
                }
            }
        } else if (Array.isArray(p) && debugFallback) {
            shouldWarn = p.some((x) => x === null || x === undefined || x === "");
        }

        if (shouldWarn) {
            const short = sql.length > 200 ? sql.slice(0, 200) + '...' : sql;
            const msg = `[DB] DB query referencing user_id invoked without user_id parameter: ${short}`;
            logger.warn({ component: 'DB', sql: short }, msg);
            if ((process.env.OM_DB_CONSOLE || '').toLowerCase() === 'true') console.warn(msg);
        }
    } catch (e) {
        // Non-fatal: log parsing failures at warn level to avoid noisy errors
        logger.warn({ component: 'DB', err: e }, '[DB] Failed to parse SQL for user_id parameter positions; skipping noisy heuristic. Set OM_DB_DEBUG_USER_SCOPE=true to enable verbose heuristics.');
    }
}

async function initDb() {
    // Idempotent guard per-db: if we've already initialized the helpers for
    // the currently-configured metadata backend / DB path, return early.
    // Allow runtime overrides via process.env to support tests or programmatic
    // callers that change OM_DB_PATH or OM_METADATA_BACKEND mid-process. Fall
    // back to the parsed `env` values when process.env vars are not present.
    const desiredPath = (process.env.OM_METADATA_BACKEND === "postgres"
        ? "postgres"
        : process.env.OM_DB_PATH || env.db_path || "./data/openmemory.sqlite");
    if (_initialized_db_path === desiredPath) return;
    const is_pg = (process.env.OM_METADATA_BACKEND || env.metadata_backend) === "postgres";
    // Tenant enforcement is controlled by the environment variable
    // `OM_STRICT_TENANT`. Do not set a default here so test harnesses and
    // programmatic callers can control tenant mode explicitly.
    /*
     Postgres runtime behavior and fallback
     --------------------------------------
     The code below prefers Bun's native Postgres client when available at
     runtime (for example when running on Bun builds that include Postgres
     support). If Bun's Postgres client is not present, the module will
     dynamically import and use the Node `pg` driver as a runtime fallback.

     Operators can influence this behavior with the following environment
     variables:
         - OM_METADATA_BACKEND=postgres : select the Postgres metadata backend
         - OM_ENABLE_PG=false           : explicitly disable any Postgres client

     Notes:
         - The Bun client path is preferred for performance on Bun runtimes.
         - The node `pg` fallback is used to maintain compatibility in
             environments where Bun Postgres is not available (CI runners, local
             Node-based containers, or contributor machines). This fallback is
             loaded dynamically at runtime and does not introduce a hard
             dependency for Bun-native deployments.
         - See MIGRATION.md and backend/README.md for CI guidance and how to
             control runtime selection.
    */
    if (is_pg) {
        // Allow operators to explicitly disable Postgres attempt via OM_ENABLE_PG=false
        if (process.env.OM_ENABLE_PG === "false") {
            const msg = "OM_ENABLE_PG=false - Postgres support disabled in this runtime. Set OM_ENABLE_PG=true to enable Bun Postgres or use OM_METADATA_BACKEND=sqlite to use SQLite instead.";
            logger.error({ component: "DB" }, msg);
            throw new Error(msg);
        }
        // Runtime: prefer Bun's native Postgres client when available. If a
        // Bun Postgres client cannot be located, fall back to the Node
        // `pg` package which will be dynamically imported. The fallback
        // preserves the existing query/transaction semantics so CI and
        // non-Bun environments continue to work.
        const bunRuntime = (globalThis as any).Bun;
        const bunPg = bunRuntime && (bunRuntime.connectPostgres || bunRuntime.postgres || bunRuntime.Postgres || bunRuntime.PostgresClient);

        // (fallback logic moved to use the already-declared opts below)

        // Note: Schema and table names are still controlled exclusively via
        // OM_PG_SCHEMA, OM_PG_TABLE, and OM_VECTOR_TABLE env vars. They are not
        // inferred from the search_path or any other connection string parameters
        // to avoid operator confusion. Operators must set these env vars explicitly
        // for non-default schemas.

        // Support an explicit Postgres connection string in libpq URI format
        // via OM_PG_CONNECTION_STRING for operator convenience. When set and valid,
        // it takes precedence over individual OM_PG_* env vars and controls SSL/TLS
        // behavior via its sslmode parameter. OM_PG_SSL is only consulted when
        // the connection string is absent or invalid.
        // The connection string is read dynamically via getConfig() to support
        // hot-reload semantics in tests that modify process.env after module import.
        let opts: any = parsePgConnectionString((await import("./cfg")).getConfig().pg_connection_string, logger);

        // If no connection string parts were parsed, fall back to discrete env vars
        if (!opts.host) {
            const ssl =
                process.env.OM_PG_SSL === "require"
                    ? { rejectUnauthorized: false }
                    : process.env.OM_PG_SSL === "disable"
                        ? false
                        : undefined;
            const db_name = process.env.OM_PG_DB || "openmemory";
            opts = {
                host: process.env.OM_PG_HOST,
                port: process.env.OM_PG_PORT ? +process.env.OM_PG_PORT : undefined,
                database: db_name,
                user: process.env.OM_PG_USER,
                password: process.env.OM_PG_PASSWORD,
                ssl,
            };
        }

        // Construct a Postgres client. Prefer Bun's Postgres client when
        // available; otherwise fall back to the Node 'pg' driver. The
        // resulting `bunClient` object must expose `query(sql, params)`.
        let bunClient: any;
        try {
            if (bunPg) {
                if (typeof bunPg === "function") {
                    bunClient = bunPg(opts);
                } else {
                    try {
                        bunClient = new (bunPg as any)(opts);
                    } catch (e) {
                        if (typeof (bunRuntime as any).connectPostgres === "function") {
                            bunClient = (bunRuntime as any).connectPostgres(opts);
                        } else {
                            bunClient = null;
                        }
                    }
                }
            }

            if (!bunClient) {
                // Fallback to node 'pg' driver (create a pool and reserve a client)
                const pgMod = await import("pg");
                const Pool = pgMod.Pool || pgMod.default?.Pool;
                if (!Pool) throw new Error("pg Pool not found");
                const pool = new Pool({
                    host: opts.host,
                    port: opts.port,
                    database: opts.database,
                    user: opts.user,
                    password: opts.password,
                    ssl: opts.ssl,
                });
                const client = await pool.connect();
                // store pool + client for later cleanup
                _pgPool = pool;
                _pgClient = client;
                bunClient = client;
                logger.info({ component: "DB" }, "[DB] Using node 'pg' client as Postgres backend fallback");
            }
        } catch (e) {
            const bunInfo = bunRuntime && bunRuntime.version ? `Bun version: ${bunRuntime.version}` : "Bun runtime: not detected or lacks Postgres support";
            logger.error({ component: "DB", err: e }, "[DB] No Postgres client available. Bun Postgres not found and node 'pg' import failed. " + bunInfo + ". If you want to use SQLite, set OM_METADATA_BACKEND=sqlite.");
            throw new Error("Postgres client unavailable: install 'pg' or run Bun with Postgres support.");
        }

        // Record Bun client (if present) for cleanup, and verify connection
        _pgClient = _pgClient || bunClient;
        try {
            await bunClient.query("SELECT 1");
        } catch (e) {
            logger.error({ component: "DB", err: e }, "[DB] Bun Postgres client failed to connect");
            throw e;
        }

        let txDepth = 0;
        const sc = process.env.OM_PG_SCHEMA || "public";
        const m = `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"`;
        memories_table = m;
        const v = `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`;
        const w = `"${sc}"."openmemory_waypoints"`;
        const l = `"${sc}"."openmemory_embed_logs"`;

        // Timed exec wrapper for logging and optional user-scoped guard
        const timedExec = async (sql: string, p: any[] = []) => {
            const start = Date.now();
            try {
                const res = await bunClient.query(sql, p);
                const dur = Date.now() - start;
                if (process.env.OM_DB_LOG === "true") {
                    const msg = `[DB] DB query (${dur}ms): ${sql.length > 200 ? sql.slice(0, 200) + '...' : sql}`;
                    logger.info({ component: "DB", sql: sql.length > 200 ? sql.slice(0, 200) + '...' : sql, duration_ms: dur }, msg);
                    if ((process.env.OM_DB_CONSOLE || "").toLowerCase() === "true") console.log(msg);
                }
                // Centralized user-scope warning helper (keeps behavior identical)
                warnIfMissingUserId(sql, p);
                return res && (res as any).rows ? (res as any).rows : res;
            } catch (e) {
                const msg = `[DB] DB query error: ${String(e)} SQL: ${sql}`;
                logger.error({ component: "DB", sql, err: e }, msg);
                if ((process.env.OM_DB_CONSOLE || "").toLowerCase() === "true") console.error(msg, e);
                throw e;
            }
        };

        run_async = async (sql: string, p: any[] = []) => {
            await timedExec(sql, p);
        };
        get_async = async (sql: string, p: any[] = []) => (await timedExec(sql, p))[0];
        all_async = async (sql: string, p: any[] = []) => await timedExec(sql, p);

        transaction = {
            begin: async () => {
                if (txDepth === 0) {
                    await bunClient.query("BEGIN");
                    txDepth = 1;
                } else {
                    await bunClient.query(`SAVEPOINT sp_${txDepth}`);
                    txDepth++;
                }
            },
            commit: async () => {
                if (txDepth === 0) return;
                if (txDepth === 1) {
                    await bunClient.query("COMMIT");
                    txDepth = 0;
                } else {
                    txDepth--;
                    await bunClient.query(`RELEASE SAVEPOINT sp_${txDepth}`);
                }
            },
            rollback: async () => {
                if (txDepth === 0) return;
                if (txDepth === 1) {
                    await bunClient.query("ROLLBACK");
                    txDepth = 0;
                } else {
                    txDepth--;
                    await bunClient.query(`ROLLBACK TO SAVEPOINT sp_${txDepth}`);
                }
            },
        };

        // Ensure necessary tables exist (awaited)
        try {
            await bunClient.query(
                `create table if not exists ${m}(id uuid primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at bigint,updated_at bigint,last_seen_at bigint,salience double precision,decay_lambda double precision,version integer default 1,mean_dim integer,mean_vec bytea,compressed_vec bytea,feedback_score double precision default 0)`
            );
            await bunClient.query(
                `create table if not exists ${v}(id uuid,sector text,user_id text,v bytea,dim integer not null,primary key(id,sector,user_id))`
            );
            await bunClient.query(
                `create table if not exists ${w}(src_id text,dst_id text not null,user_id text,weight double precision not null,created_at bigint,updated_at bigint,primary key(src_id,user_id))`
            );
            await bunClient.query(
                `create table if not exists ${l}(id text primary key,model text,status text,ts bigint,err text)`
            );
            await bunClient.query(
                `create table if not exists "${sc}"."openmemory_stream_telemetry"(id text primary key,user_id text,embedding_mode text,duration_ms bigint,memory_ids jsonb,query text,ts bigint)`
            );
            await bunClient.query(
                `create table if not exists "${sc}"."openmemory_users"(user_id text primary key,summary text,reflection_count integer default 0,created_at bigint,updated_at bigint)`
            );
            // Ensure maintenance/statistics and temporal tables exist in Postgres
            // to match the SQLite branch. These tables power maintenance logging
            // (`log_maint_op`) and temporal facts/edges features used in tests
            // and some domain workflows.
            await bunClient.query(
                `create table if not exists "${sc}"."openmemory_stats"(id bigserial primary key,type text not null,count integer default 1,ts bigint not null)`
            );
            await bunClient.query(
                `create table if not exists "${sc}"."openmemory_temporal_facts"(id text primary key,subject text not null,predicate text not null,object text not null,valid_from bigint not null,valid_to bigint,confidence double precision not null check(confidence >= 0 and confidence <= 1),last_updated bigint not null,metadata text,unique(subject,predicate,object,valid_from))`
            );
            await bunClient.query(
                `create table if not exists "${sc}"."openmemory_temporal_edges"(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from bigint not null,valid_to bigint,weight double precision not null,metadata text)`
            );
            // Create helpful indexes similar to the SQLite branch
            await bunClient.query(`create index if not exists "idx_stats_ts" on "${sc}"."openmemory_stats"(ts)`);
            await bunClient.query(`create index if not exists "idx_stream_telemetry_ts" on "${sc}"."openmemory_stream_telemetry"(ts)`);
            await bunClient.query(`create index if not exists "idx_temporal_subject" on "${sc}"."openmemory_temporal_facts"(subject)`);
            await bunClient.query(`create index if not exists "idx_temporal_predicate" on "${sc}"."openmemory_temporal_facts"(predicate)`);
            await bunClient.query(`create index if not exists "idx_temporal_validity" on "${sc}"."openmemory_temporal_facts"(valid_from,valid_to)`);
            await bunClient.query(`create index if not exists "idx_edges_source" on "${sc}"."openmemory_temporal_edges"(source_id)`);
            await bunClient.query(`create index if not exists "idx_edges_target" on "${sc}"."openmemory_temporal_edges"(target_id)`);
        } catch (e) {
            logger.error({ component: "DB", err: e }, "[DB] Failed to create tables with Bun Postgres client");
            throw e;
        }

        // Postgres query helper object (uses $1 placeholders)
        // NOTE: The SQLite `q` helpers below intentionally support legacy and
        // newer call shapes. Historically some callers omitted a trailing
        // `user_id` parameter and the SQL used `(? is null or user_id=?)` to
        // allow global access. When `OM_STRICT_TENANT=true`, these helpers
        // will throw if an explicit `user_id` is not supplied. Operators
        // should update callers to pass a `user_id` explicitly to opt into
        // strict tenant enforcement.
        q = {
            ins_mem: {
                run: (...p) => {
                    const mapParams = (args: any[]) => {
                        if (!args || args.length === 0) return args;
                        if (args.length === 18) return args;
                        const [id, content, primary_sector, tags, meta, created_at, updated_at, last_seen_at, salience, decay_lambda, version, user_id, mean_dim, mean_vec, compressed_vec] = args;
                        const segment = 0;
                        const simhash = null;
                        const feedback_score = 0;
                        return [
                            id,
                            user_id || null,
                            segment,
                            content,
                            simhash,
                            primary_sector,
                            tags,
                            meta,
                            created_at,
                            updated_at,
                            last_seen_at,
                            salience,
                            decay_lambda,
                            version,
                            mean_dim || null,
                            mean_vec || null,
                            compressed_vec || null,
                            feedback_score,
                        ];
                    };
                    const params = mapParams(p);
                    // Enforce tenant scoping for inserts when OM_STRICT_TENANT is enabled
                    const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                    const user_id = Array.isArray(params) && params.length > 1 ? params[1] : null;
                    if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                        const msg = `Tenant-scoped write (ins_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB' }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `insert into ${m}(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) on conflict(id) do update set user_id=excluded.user_id,segment=excluded.segment,content=excluded.content,simhash=excluded.simhash,primary_sector=excluded.primary_sector,tags=excluded.tags,meta=excluded.meta,created_at=excluded.created_at,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience,decay_lambda=excluded.decay_lambda,version=excluded.version,mean_dim=excluded.mean_dim,mean_vec=excluded.mean_vec,compressed_vec=excluded.compressed_vec,feedback_score=excluded.feedback_score`,
                        params,
                    );
                },
            },
            upd_mean_vec: {
                run: (...p) => {
                    // Normalize parameters: (id, mean_dim, mean_vec [, user_id])
                    let id: any, mean_dim: any, mean_vec: any, user_id: any;
                    if (p.length === 4) [id, mean_dim, mean_vec, user_id] = p as any[];
                    else[id, mean_dim, mean_vec] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_mean_vec) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `update ${m} set mean_dim=$2,mean_vec=$3 where id=$1 and ($4 is null or user_id=$4)`,
                        [id, mean_dim, mean_vec, user_id],
                    );
                },
            },
            upd_compressed_vec: {
                run: (...p) => {
                    // Normalize parameters: (id, compressed_vec [, user_id])
                    let id: any, compressed_vec: any, user_id: any;
                    if (p.length === 3) [id, compressed_vec, user_id] = p as any[];
                    else[id, compressed_vec] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_compressed_vec) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `update ${m} set compressed_vec=$2 where id=$1 and ($3 is null or user_id=$3)`,
                        [id, compressed_vec, user_id],
                    );
                },
            },
            upd_feedback: {
                run: (...p) => {
                    // Normalize parameters: (id, feedback_score [, user_id])
                    let id: any, feedback_score: any, user_id: any;
                    if (p.length === 3) [id, feedback_score, user_id] = p as any[];
                    else[id, feedback_score] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_feedback) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `update ${m} set feedback_score=$2 where id=$1 and ($3 is null or user_id=$3)`,
                        [id, feedback_score, user_id],
                    );
                },
            },
            upd_seen: {
                run: (...p) => {
                    // Normalize parameters: (id, last_seen_at, salience, updated_at [, user_id])
                    let id: any, last_seen_at: any, salience: any, updated_at: any, user_id: any;
                    if (p.length === 5) [id, last_seen_at, salience, updated_at, user_id] = p as any[];
                    else[id, last_seen_at, salience, updated_at] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_seen) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `update ${m} set last_seen_at=$2,salience=$3,updated_at=$4 where id=$1 and ($5 is null or user_id=$5)`,
                        [id, last_seen_at, salience, updated_at, user_id],
                    );
                },
            },
            upd_mem: {
                run: (...p) => {
                    // Normalize parameters: (content, tags, meta, updated_at, id [, user_id])
                    let content: any, tags: any, meta: any, updated_at: any, id: any, user_id: any;
                    if (p.length === 6) [content, tags, meta, updated_at, id, user_id] = p as any[];
                    else[content, tags, meta, updated_at, id] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `update ${m} set content=$1,tags=$2,meta=$3,updated_at=$4,version=version+1 where id=$5 and ($6 is null or user_id=$6)`,
                        [content, tags, meta, updated_at, id, user_id],
                    );
                },
            },
            upd_mem_with_sector: {
                run: (...p) => {
                    // Normalize parameters: (content, primary_sector, tags, meta, updated_at, id [, user_id])
                    let content: any, primary_sector: any, tags: any, meta: any, updated_at: any, id: any, user_id: any;
                    if (p.length === 7) [content, primary_sector, tags, meta, updated_at, id, user_id] = p as any[];
                    else[content, primary_sector, tags, meta, updated_at, id] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_mem_with_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `update ${m} set content=$1,primary_sector=$2,tags=$3,meta=$4,updated_at=$5,version=version+1 where id=$6 and ($7 is null or user_id=$7)`,
                        [content, primary_sector, tags, meta, updated_at, id, user_id],
                    );
                },
            },
            del_mem: {
                run: (...p) => {
                    // Accept either (id) or (id, user_id)
                    const id = p[0];
                    const user_id = p.length > 1 ? p[1] : null;
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (del_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `delete from ${m} where id=$1 and ($2 is null or user_id=$2)`,
                        [id, user_id],
                    );
                },
            },
            get_mem: {
                get: (id, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return get_async(
                        `select * from ${m} where id=$1 and ($2 is null or user_id=$2)`,
                        [id, user_id],
                    );
                },
            },
            get_mem_by_simhash: {
                get: (simhash, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_mem_by_simhash) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", simhash }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return get_async(
                        `select * from ${m} where simhash=$1 and ($2 is null or user_id=$2) order by salience desc limit 1`,
                        [simhash, user_id],
                    );
                },
            },
            all_mem: {
                all: (limit, offset, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (all_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB" }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    if (user_id) {
                        return all_async(
                            `select * from ${m} where user_id=$3 order by created_at desc limit $1 offset $2`,
                            [limit, offset, user_id],
                        );
                    }
                    return all_async(
                        `select * from ${m} order by created_at desc limit $1 offset $2`,
                        [limit, offset],
                    );
                },
            },
            all_mem_by_sector: {
                all: (sector, limit, offset, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (all_mem_by_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    if (user_id) {
                        return all_async(
                            `select * from ${m} where primary_sector=$1 and user_id=$4 order by created_at desc limit $2 offset $3`,
                            [sector, limit, offset, user_id],
                        );
                    }
                    return all_async(
                        `select * from ${m} where primary_sector=$1 order by created_at desc limit $2 offset $3`,
                        [sector, limit, offset],
                    );
                },
            },
            all_mem_by_user_and_sector: {
                all: (user_id, sector, limit, offset) => {
                    const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                    if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                        const msg = `Tenant-scoped read (all_mem_by_user_and_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB' }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return all_async(
                        `select * from ${m} where user_id=$1 and primary_sector=$2 order by created_at desc limit $3 offset $4`,
                        [user_id, sector, limit, offset],
                    );
                },
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
            ins_vec: {
                run: (...p) =>
                    run_async(
                        `insert into ${v}(id,sector,user_id,v,dim) values($1,$2,$3,$4,$5) on conflict(id,sector,user_id) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim`,
                        p,
                    ),
            },
            get_vec: {
                get: (id, sector, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_vec) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id, sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return get_async(
                        `select v,dim from ${v} where id=$1 and sector=$2 and ($3 is null or user_id=$3)`,
                        [id, sector, user_id],
                    );
                },
            },
            get_vecs_by_id: {
                all: (id, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_vecs_by_id) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return all_async(`select sector,v,dim from ${v} where id=$1 and ($2 is null or user_id=$2)`, [id, user_id]);
                },
            },
            get_vecs_by_sector: {
                all: (sector, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_vecs_by_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return all_async(`select id,v,dim from ${v} where sector=$1 and ($2 is null or user_id=$2)`, [sector, user_id]);
                },
            },
            get_vecs_batch: {
                all: (ids: string[], sector: string, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_vecs_batch) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    if (!ids.length) return Promise.resolve([]);
                    const ph = ids.map((_, i) => `$${i + 3}`).join(",");
                    // $1 = sector, $2 = user_id, $3.. = ids
                    return all_async(
                        `select id,v,dim from ${v} where sector=$1 and ($2 is null or user_id=$2) and id in (${ph})`,
                        [sector, user_id, ...ids],
                    );
                },
            },
            del_vec: {
                // Accept optional user_id to scope destructive deletes
                run: (...p) => {
                    // params: id, user_id?
                    const id = p[0];
                    const user_id = p.length > 1 ? p[1] : null;
                    const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                    if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                        const msg = `Tenant-scoped write (del_vec) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB', id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(`delete from ${v} where id=$1 and ($2 is null or user_id=$2)`, [id, user_id]);
                },
            },
            del_vec_sector: {
                run: (...p) => {
                    const id = p[0];
                    const sector = p[1];
                    const user_id = p.length > 2 ? p[2] : null;
                    const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                    if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                        const msg = `Tenant-scoped write (del_vec_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB', id, sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(`delete from ${v} where id=$1 and sector=$2 and ($3 is null or user_id=$3)`, [id, sector, user_id]);
                },
            },
            ins_waypoint: {
                run: (...p) =>
                    run_async(
                        `insert into ${w}(src_id,dst_id,user_id,weight,created_at,updated_at) values($1,$2,$3,$4,$5,$6) on conflict(src_id,user_id) do update set dst_id=excluded.dst_id,weight=excluded.weight,updated_at=excluded.updated_at`,
                        p,
                    ),
            },
            get_neighbors: {
                all: (src, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_neighbors) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", src }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return all_async(
                        `select dst_id,weight from ${w} where src_id=$1 and ($2 is null or user_id=$2) order by weight desc`,
                        [src, user_id],
                    );
                },
            },
            get_waypoints_by_src: {
                all: (src, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_waypoints_by_src) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", src }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return all_async(
                        `select src_id,dst_id,weight,created_at,updated_at from ${w} where src_id=$1 and ($2 is null or user_id=$2)`,
                        [src, user_id],
                    );
                },
            },
            get_waypoint: {
                get: (src, dst, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_waypoint) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", src, dst }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return get_async(
                        `select weight from ${w} where src_id=$1 and dst_id=$2 and ($3 is null or user_id=$3)`,
                        [src, dst, user_id],
                    );
                },
            },
            upd_waypoint: {
                // Preserve flexible param ordering at call-sites by accepting any order,
                // but normalize here: expect run(src, dst, weight, updated_at, user_id)
                run: (...p) => {
                    // normalize parameters into (src, dst, weight, updated_at, user_id)
                    let src: any, dst: any, weight: any, updated_at: any, user_id: any;
                    if (p.length === 5) [src, dst, weight, updated_at, user_id] = p;
                    else if (p.length === 4) [src, dst, weight, updated_at] = p;
                    else if (p.length === 3) [src, dst, weight] = p;
                    else if (p.length === 2) [src, dst] = p;
                    // Fallback: some callers passed (weight, updated_at, src, dst). Detect that common pattern.
                    if (!src && p.length === 4 && typeof p[0] === "number") {
                        // assume ordering weight, updated_at, src, dst
                        weight = p[0];
                        updated_at = p[1];
                        src = p[2];
                        dst = p[3];
                    }
                    const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                    if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                        const msg = `Tenant-scoped write (upd_waypoint) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB', src, dst }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return run_async(
                        `update ${w} set weight=$3,updated_at=$4 where src_id=$1 and dst_id=$2 and ($5 is null or user_id=$5)`,
                        [src, dst, weight, updated_at, user_id],
                    );
                },
            },
            del_waypoints: {
                run: (...p) =>
                    // keep a user_id optional guard; callers can pass (src, dst, user_id) or (src, dst)
                    ((): Promise<void> => {
                        const [src, dst, user_id = null] = p as any[];
                        const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                        if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                            const msg = `Tenant-scoped write (del_waypoints) requires user_id when OM_STRICT_TENANT=true`;
                            logger.error({ component: 'DB', src, dst }, `[DB] ${msg}`);
                            throw new Error(msg);
                        }
                        return run_async(`delete from ${w} where (src_id=$1 or dst_id=$2) and ($3 is null or user_id=$3)`, [src, dst, user_id]);
                    })(),
            },
            prune_waypoints: {
                run: (t) => run_async(`delete from ${w} where weight<$1`, [t]),
            },
            ins_log: {
                run: (...p) =>
                    run_async(
                        `insert into ${l}(id,model,status,ts,err) values($1,$2,$3,$4,$5) on conflict(id) do update set model=excluded.model,status=excluded.status,ts=excluded.ts,err=excluded.err`,
                        p,
                    ),
            },
            ins_stream_telemetry: {
                run: (id: string, user_id: string | null, embedding_mode: string | null, duration_ms: number, memory_ids: string, query: string, ts: number) =>
                    // Enforce tenant scoping on telemetry insert when OM_STRICT_TENANT is enabled
                    // to avoid unscoped telemetry being written in strict tenant modes.
                    (() => {
                        const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                        if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                            const msg = `Tenant-scoped write (ins_stream_telemetry) requires user_id when OM_STRICT_TENANT=true`;
                            logger.error({ component: 'DB' }, `[DB] ${msg}`);
                            throw new Error(msg);
                        }
                        return run_async(
                            `insert into "${sc}"."openmemory_stream_telemetry"(id,user_id,embedding_mode,duration_ms,memory_ids,query,ts) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set user_id=excluded.user_id,embedding_mode=excluded.embedding_mode,duration_ms=excluded.duration_ms,memory_ids=excluded.memory_ids,query=excluded.query,ts=excluded.ts`,
                            [id, user_id, embedding_mode, duration_ms, memory_ids, query, ts],
                        );
                    })(),
            },
            upd_log: {
                // Match call-site signature used elsewhere: upd_log.run(status, err, id)
                run: (...p) =>
                    run_async(`update ${l} set status=$1,err=$2 where id=$3`, p),
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
            get_stream_telemetry: {
                all: (limit = 50, offset = 0) =>
                    all_async(
                        `select id,user_id,embedding_mode,duration_ms,memory_ids,query,ts from "${sc}"."openmemory_stream_telemetry" order by ts desc limit $1 offset $2`,
                        [limit, offset],
                    ),
            },
            all_mem_by_user: {
                all: (user_id, limit, offset) => {
                    const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                    if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                        const msg = `Tenant-scoped read (all_mem_by_user) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB' }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return all_async(
                        `select * from ${m} where user_id=$1 order by created_at desc limit $2 offset $3`,
                        [user_id, limit, offset],
                    );
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
        };
    } else {
        // Get runtime capabilities and log the choice
        const capabilities = detectSQLiteCapabilities();
        logger.info({ component: "DB", runtime: capabilities.runtime, recommended: capabilities.recommended },
            `[DB] Using ${capabilities.recommended} SQLite implementation`);

        const db_path = process.env.OM_DB_PATH || env.db_path || "./data/openmemory.sqlite";
        const dir = path.dirname(db_path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Use cross-runtime SQLite database
        const db = await createSQLiteDatabase(db_path);
        _sqliteDb = db;

        // Tune pragmas for reliability in multi-process test environments.
        // Set a generous busy timeout early so transient locks are retried.
        // For SQLite, support nested transactions via savepoints using an in-process counter
        // and tune pragmas to be tolerant in test environments.
        // Prefer prepared execution to avoid deprecated exec overloads.
        // Some PRAGMAs do not support bound parameters; execute directly here.
        db.run("PRAGMA busy_timeout=5000");
        db.run("PRAGMA journal_mode=WAL");
        db.run("PRAGMA synchronous=NORMAL");
        db.run("PRAGMA temp_store=MEMORY");
        db.run("PRAGMA cache_size=-8000");
        db.run("PRAGMA mmap_size=134217728");
        db.run("PRAGMA foreign_keys=OFF");
        db.run("PRAGMA wal_autocheckpoint=20000");
        if (process.env.OM_DB_LOG === "true") {
            const msg = "[DB] SQLite PRAGMA journal_mode=WAL enabled";
            logger.info({ component: "DB" }, msg);
            if ((process.env.OM_DB_CONSOLE || "").toLowerCase() === "true") console.log(msg);
        }
        // Use NORMAL locking mode to avoid holding exclusive locks across processes
        // which can cause SQLITE_BUSY during parallel test runs or when a test helper
        // launches a server process that also opens the DB file.
        db.run("PRAGMA locking_mode=NORMAL");
        db.run(
            `create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`
        );
        db.run(
            `create table if not exists vectors(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector,user_id))`
        );
        db.run(
            `create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,user_id))`
        );
        db.run(
            `create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)`
        );
        db.run(
            `create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`
        );
        db.run(
            `create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)`
        );
        db.run(
            `create table if not exists stream_telemetry(id text primary key,user_id text,embedding_mode text,duration_ms integer,memory_ids text,query text,ts integer)`
        );
        db.run(
            `create index if not exists idx_stream_telemetry_ts on stream_telemetry(ts)`
        );
        db.run(
            `create table if not exists temporal_facts(id text primary key,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))`
        );
        db.run(
            `create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))`
        );
        db.run(
            "create index if not exists idx_memories_sector on memories(primary_sector)"
        );
        db.run(
            "create index if not exists idx_memories_segment on memories(segment)"
        );
        db.run(
            "create index if not exists idx_memories_simhash on memories(simhash)"
        );
        db.run(
            "create index if not exists idx_memories_ts on memories(last_seen_at)"
        );
        db.run(
            "create index if not exists idx_memories_user on memories(user_id)"
        );
        db.run(
            "create index if not exists idx_vectors_user on vectors(user_id)"
        );
        db.run(
            "create index if not exists idx_waypoints_src on waypoints(src_id)"
        );
        db.run(
            "create index if not exists idx_waypoints_dst on waypoints(dst_id)"
        );
        db.run(
            "create index if not exists idx_waypoints_user on waypoints(user_id)"
        );
        db.run("create index if not exists idx_stats_ts on stats(ts)");
        db.run("create index if not exists idx_stats_type on stats(type)");
        db.run(
            "create index if not exists idx_temporal_subject on temporal_facts(subject)"
        );
        db.run(
            "create index if not exists idx_temporal_predicate on temporal_facts(predicate)"
        );
        db.run(
            "create index if not exists idx_temporal_validity on temporal_facts(valid_from,valid_to)"
        );
        db.run(
            "create index if not exists idx_temporal_composite on temporal_facts(subject,predicate,valid_from,valid_to)"
        );
        db.run(
            "create index if not exists idx_edges_source on temporal_edges(source_id)"
        );
        db.run(
            "create index if not exists idx_edges_target on temporal_edges(target_id)"
        );
        db.run(
            "create index if not exists idx_edges_validity on temporal_edges(valid_from,valid_to)"
        );

        memories_table = "memories";
        const SLOW_MS = process.env.OM_DB_SLOW_MS ? +process.env.OM_DB_SLOW_MS : 50;

        // NOTE: Removed unused `_hasUserIdParam` helper. The user-scope
        // warning logic below performs SQL parsing to determine parameter
        // positions for `user_id` and inspects the `p` array directly. This
        // avoids a separate heuristic helper that produced false positives.

        const exec = (sql: string, p: any[] = []) => {
            const start = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
            try {
                db.prepare(sql).run(...p);
                const dur = ((globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now()) - start;
                if (process.env.OM_DB_LOG === "true" && dur > SLOW_MS) {
                    const msg = `[DB] DB slow query (${Math.round(dur)}ms): ${sql.length > 200 ? sql.slice(0, 200) + "..." : sql}`;
                    logger.info({ component: "DB", sql: sql.length > 200 ? sql.slice(0, 200) + "..." : sql, duration_ms: Math.round(dur) }, msg);
                    if ((process.env.OM_DB_CONSOLE || "").toLowerCase() === "true") console.log(msg);
                }
                warnIfMissingUserId(sql, p);
                return Promise.resolve();
            } catch (e) {
                logger.error({ component: "DB", sql, err: e }, "DB exec error");
                return Promise.reject(e);
            }
        };

        const one = (sql: string, p: any[] = []) => {
            const start = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
            try {
                const row = db.prepare(sql).get(...p);
                const dur = ((globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now()) - start;
                if (process.env.OM_DB_LOG === "true" && dur > SLOW_MS) {
                    const msg = `[DB] DB slow query (${Math.round(dur)}ms): ${sql.length > 200 ? sql.slice(0, 200) + "..." : sql}`;
                    logger.info({ component: "DB", sql: sql.length > 200 ? sql.slice(0, 200) + "..." : sql, duration_ms: Math.round(dur) }, msg);
                    if ((process.env.OM_DB_CONSOLE || "").toLowerCase() === "true") console.log(msg);
                }
                warnIfMissingUserId(sql, p);
                return Promise.resolve(row);
            } catch (e) {
                logger.error({ component: "DB", sql, err: e }, "[DB] DB query error");
                return Promise.reject(e);
            }
        };

        const many = (sql: string, p: any[] = []) => {
            const start = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
            try {
                const rows = db.prepare(sql).all(...p);
                const dur = ((globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now()) - start;
                if (process.env.OM_DB_LOG === "true" && dur > SLOW_MS) {
                    const msg = `[DB] DB slow query (${Math.round(dur)}ms): ${sql.length > 200 ? sql.slice(0, 200) + "..." : sql}`;
                    logger.info({ component: "DB", sql: sql.length > 200 ? sql.slice(0, 200) + "..." : sql, duration_ms: Math.round(dur) }, msg);
                    if ((process.env.OM_DB_CONSOLE || "").toLowerCase() === "true") console.log(msg);
                }
                warnIfMissingUserId(sql, p);
                return Promise.resolve(rows as any[]);
            } catch (e) {
                logger.error({ component: "DB", sql, err: e }, "DB query error");
                return Promise.reject(e);
            }
        };

        run_async = exec;
        get_async = one;
        all_async = many;
        // Nested transaction support for SQLite using savepoints.
        let txDepth = 0;
        transaction = {
            begin: async () => {
                if (txDepth === 0) {
                    await exec("BEGIN TRANSACTION");
                    txDepth = 1;
                } else {
                    await exec(`SAVEPOINT sp_${txDepth}`);
                    txDepth++;
                }
            },
            commit: async () => {
                if (txDepth === 0) return;
                if (txDepth === 1) {
                    await exec("COMMIT");
                    txDepth = 0;
                } else {
                    txDepth--;
                    await exec(`RELEASE SAVEPOINT sp_${txDepth}`);
                }
            },
            rollback: async () => {
                if (txDepth === 0) return;
                if (txDepth === 1) {
                    await exec("ROLLBACK");
                    txDepth = 0;
                } else {
                    txDepth--;
                    await exec(`ROLLBACK TO SAVEPOINT sp_${txDepth}`);
                }
            },
        };
        q = {
            ins_mem: {
                run: (...p) => {
                    // Accept legacy caller order for compatibility with existing code
                    const mapParams = (args: any[]) => {
                        if (!args || args.length === 0) return args;
                        if (args.length === 18) return args;
                        const [id, content, primary_sector, tags, meta, created_at, updated_at, last_seen_at, salience, decay_lambda, version, user_id, mean_dim, mean_vec, compressed_vec] = args;
                        const segment = 0;
                        const simhash = null;
                        const feedback_score = 0;
                        return [
                            id,
                            user_id || null,
                            segment,
                            content,
                            simhash,
                            primary_sector,
                            tags,
                            meta,
                            created_at,
                            updated_at,
                            last_seen_at,
                            salience,
                            decay_lambda,
                            version,
                            mean_dim || null,
                            mean_vec || null,
                            compressed_vec || null,
                            feedback_score,
                        ];
                    };
                    const params = mapParams(p);
                    // Enforce tenant scoping for inserts when OM_STRICT_TENANT is enabled
                    const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                    const user_id = Array.isArray(params) && params.length > 1 ? params[1] : null;
                    if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                        const msg = `Tenant-scoped write (ins_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB', id: params && params[0] }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec(
                        "insert into memories(id,user_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        params,
                    );
                },
            },
            upd_mean_vec: {
                run: (...p) => {
                    // Preserve backward-compatible ordering and support the
                    // canonical `id-first` signature used in TypeScript. Accept
                    // either (mean_dim, mean_vec, id [, user_id]) or
                    // (id, mean_dim, mean_vec [, user_id]). Detect by arg
                    // types: if the first arg is a string or UUID-like, treat
                    // the first param as `id`.
                    let id: any, mean_dim: any, mean_vec: any, user_id: any;
                    if (p.length === 4) {
                        // Heuristic: if first param is a string, assume id-first
                        if (typeof p[0] === 'string') [id, mean_dim, mean_vec, user_id] = p as any[];
                        else[mean_dim, mean_vec, id, user_id] = p as any[];
                    } else if (p.length === 3) {
                        if (typeof p[0] === 'string') [id, mean_dim, mean_vec] = p as any[];
                        else[mean_dim, mean_vec, id] = p as any[];
                    } else if (p.length === 2) {
                        // support some legacy calls that only pass mean_dim/mean_vec
                        [mean_dim, mean_vec] = p as any[];
                    }
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_mean_vec) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec("update memories set mean_dim=?,mean_vec=? where id=? and (? is null or user_id=?)", [mean_dim, mean_vec, id, user_id, user_id]);
                },
            },
            upd_compressed_vec: {
                run: (...p) => {
                    // Support both (id, compressed_vec [, user_id]) and the
                    // legacy SQLite callshape (compressed_vec, id [, user_id]).
                    let id: any, compressed_vec: any, user_id: any;
                    if (p.length === 3) {
                        // If first arg is a string we assume id-first ordering.
                        if (typeof p[0] === 'string') [id, compressed_vec, user_id] = p as any[];
                        else[compressed_vec, id, user_id] = p as any[];
                    } else if (p.length === 2) {
                        if (typeof p[0] === 'string') [id, compressed_vec] = p as any[];
                        else[compressed_vec, id] = p as any[];
                    }
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_compressed_vec) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec("update memories set compressed_vec=? where id=? and (? is null or user_id=?)", [compressed_vec, id, user_id, user_id]);
                },
            },
            upd_feedback: {
                run: (...p) => {
                    // Preserve backward-compatible ordering: (feedback_score, id [, user_id])
                    let feedback_score: any, id: any, user_id: any;
                    if (p.length === 3) [feedback_score, id, user_id] = p as any[];
                    else[feedback_score, id] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_feedback) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec("update memories set feedback_score=? where id=? and (? is null or user_id=?)", [feedback_score, id, user_id, user_id]);
                },
            },
            upd_seen: {
                run: (...p) => {
                    // Accept both canonical `id-first` and legacy `lastSeen-first`
                    // forms. Heuristic: if first param is a string assume id-first.
                    let id: any, last_seen_at: any, salience: any, updated_at: any, user_id: any;
                    if (p.length === 5) {
                        if (typeof p[0] === 'string') [id, last_seen_at, salience, updated_at, user_id] = p as any[];
                        else[last_seen_at, salience, updated_at, id, user_id] = p as any[];
                    } else if (p.length === 4) {
                        if (typeof p[0] === 'string') [id, last_seen_at, salience, updated_at] = p as any[];
                        else[last_seen_at, salience, updated_at, id] = p as any[];
                    }
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_seen) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec(
                        "update memories set last_seen_at=?,salience=?,updated_at=? where id=? and (? is null or user_id=?)",
                        [last_seen_at, salience, updated_at, id, user_id, user_id],
                    );
                },
            },
            upd_mem: {
                run: (...p) => {
                    // Preserve backward-compatible ordering: (content, tags, meta, updated_at, id [, user_id])
                    let content: any, tags: any, meta: any, updated_at: any, id: any, user_id: any;
                    if (p.length === 6) [content, tags, meta, updated_at, id, user_id] = p as any[];
                    else[content, tags, meta, updated_at, id] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec(
                        "update memories set content=?,tags=?,meta=?,updated_at=?,version=version+1 where id=? and (? is null or user_id=?)",
                        [content, tags, meta, updated_at, id, user_id, user_id],
                    );
                },
            },
            upd_mem_with_sector: {
                run: (...p) => {
                    // Preserve backward-compatible ordering:
                    // (content, primary_sector, tags, meta, updated_at, id [, user_id])
                    let content: any, primary_sector: any, tags: any, meta: any, updated_at: any, id: any, user_id: any;
                    if (p.length === 7) [content, primary_sector, tags, meta, updated_at, id, user_id] = p as any[];
                    else[content, primary_sector, tags, meta, updated_at, id] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_mem_with_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec(
                        "update memories set content=?,primary_sector=?,tags=?,meta=?,updated_at=?,version=version+1 where id=? and (? is null or user_id=?)",
                        [content, primary_sector, tags, meta, updated_at, id, user_id, user_id],
                    );
                },
            },
            del_mem: {
                run: (...p) => {
                    // Accept either (id) or (id, user_id)
                    const id = p[0];
                    const user_id = p.length > 1 ? p[1] : null;
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (del_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec("delete from memories where id=? and (? is null or user_id=?)", [id, user_id, user_id]);
                },
            },
            get_mem: {
                get: (id, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return one("select * from memories where id=? and (? is null or user_id=?)", [id, user_id, user_id]);
                },
            },
            get_mem_by_simhash: {
                get: (simhash, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_mem_by_simhash) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", simhash }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return one(
                        "select * from memories where simhash=? and (? is null or user_id=?) order by salience desc limit 1",
                        [simhash, user_id, user_id],
                    );
                },
            },
            all_mem: {
                all: (limit, offset, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (all_mem) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB" }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    if (user_id) {
                        return many(
                            "select * from memories where user_id=? order by created_at desc limit ? offset ?",
                            [user_id, limit, offset],
                        );
                    }
                    return many(
                        "select * from memories order by created_at desc limit ? offset ?",
                        [limit, offset],
                    );
                },
            },
            all_mem_by_sector: {
                all: (sector, limit, offset, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (all_mem_by_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    if (user_id) {
                        return many(
                            "select * from memories where primary_sector=? and user_id=? order by created_at desc limit ? offset ?",
                            [sector, user_id, limit, offset],
                        );
                    }
                    return many(
                        "select * from memories where primary_sector=? order by created_at desc limit ? offset ?",
                        [sector, limit, offset],
                    );
                },
            },
            all_mem_by_user_and_sector: {
                all: (user_id, sector, limit, offset) =>
                    many(
                        "select * from memories where user_id=? and primary_sector=? order by created_at desc limit ? offset ?",
                        [user_id, sector, limit, offset],
                    ),
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
            ins_vec: {
                run: (...p) =>
                    exec(
                        "insert into vectors(id,sector,user_id,v,dim) values(?,?,?,?,?) on conflict(id,sector,user_id) do update set user_id=excluded.user_id,v=excluded.v,dim=excluded.dim",
                        p,
                    ),
            },
            get_vec: {
                get: (id, sector, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_vec) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id, sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    // user_id optional guard
                    return one("select v,dim from vectors where id=? and sector=? and (? is null or user_id=?)", [id, sector, user_id, user_id]);
                },
            },
            get_vecs_by_id: {
                all: (id, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_vecs_by_id) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return many("select sector,v,dim from vectors where id=? and (? is null or user_id=?)", [id, user_id, user_id]);
                },
            },
            get_vecs_by_sector: {
                all: (sector, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_vecs_by_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return many("select id,v,dim from vectors where sector=? and (? is null or user_id=?)", [sector, user_id, user_id]);
                },
            },
            get_vecs_batch: {
                all: (ids: string[], sector: string, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_vecs_batch) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    if (!ids.length) return Promise.resolve([]);
                    const ph = ids.map(() => "?").join(",");
                    // params: sector, user_id, user_id, ...ids
                    return many(
                        `select id,v,dim from vectors where sector=? and (? is null or user_id=?) and id in (${ph})`,
                        [sector, user_id, user_id, ...ids],
                    );
                },
            },
            del_vec: {
                run: (...p) => {
                    const [id, user_id = null] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (del_vec) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB', id }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec("delete from vectors where id=? and (? is null or user_id=?)", [id, user_id, user_id]);
                },
            },
            del_vec_sector: {
                run: (...p) => {
                    const [id, sector, user_id = null] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (del_vec_sector) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB', id, sector }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec("delete from vectors where id=? and sector=? and (? is null or user_id=?)", [id, sector, user_id, user_id]);
                },
            },
            ins_waypoint: {
                run: (...p) =>
                    ((): Promise<void> => {
                        const [src, dst, user_id] = p as any[];
                        const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                        if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                            const msg = `Tenant-scoped write (ins_waypoint) requires user_id when OM_STRICT_TENANT=true`;
                            logger.error({ component: 'DB', src, dst }, `[DB] ${msg}`);
                            throw new Error(msg);
                        }
                        return exec(
                            "insert or replace into waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?)",
                            p,
                        );
                    })(),
            },
            get_neighbors: {
                all: (src, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_neighbors) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", src }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return many(
                        "select dst_id,weight from waypoints where src_id=? and (? is null or user_id=?) order by weight desc",
                        [src, user_id, user_id],
                    );
                },
            },
            get_waypoints_by_src: {
                all: (src, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_waypoints_by_src) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", src }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return many(
                        "select src_id,dst_id,weight,created_at,updated_at from waypoints where src_id=? and (? is null or user_id=?)",
                        [src, user_id, user_id],
                    );
                },
            },
            get_waypoint: {
                get: (src, dst, user_id = null) => {
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped read (get_waypoint) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: "DB", src, dst }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return one(
                        "select weight from waypoints where src_id=? and dst_id=? and (? is null or user_id=?)",
                        [src, dst, user_id, user_id],
                    );
                },
            },
            upd_waypoint: {
                run: (...p) => {
                    // Normalize inputs: prefer (src, dst, weight, updated_at, user_id)
                    let src: any, dst: any, weight: any, updated_at: any, user_id: any;
                    if (p.length === 5) [src, dst, weight, updated_at, user_id] = p;
                    else if (p.length === 4) [src, dst, weight, updated_at] = p;
                    else if (p.length === 3) [src, dst, weight] = p;
                    else if (p.length === 2) [src, dst] = p;
                    // Detect legacy ordering weight, updated_at, src, dst
                    if (!src && p.length === 4 && typeof p[0] === "number") {
                        weight = p[0];
                        updated_at = p[1];
                        src = p[2];
                        dst = p[3];
                    }
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (upd_waypoint) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB', src, dst }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec(
                        "update waypoints set weight=?,updated_at=? where src_id=? and dst_id=? and (? is null or user_id=?)",
                        [weight, updated_at, src, dst, user_id, user_id],
                    );
                },
            },
            del_waypoints: {
                run: (...p) => {
                    const [src, dst, user_id = null] = p as any[];
                    const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";
                    if (strict && (user_id === null || user_id === undefined || user_id === "")) {
                        const msg = `Tenant-scoped write (del_waypoints) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB', src, dst }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return exec("delete from waypoints where (src_id=? or dst_id=?) and (? is null or user_id=?)", [src, dst, user_id, user_id]);
                },
            },
            prune_waypoints: {
                run: (t) => exec("delete from waypoints where weight<?", [t]),
            },
            ins_log: {
                run: (...p) =>
                    exec(
                        "insert or replace into embed_logs(id,model,status,ts,err) values(?,?,?,?,?)",
                        p,
                    ),
            },
            upd_log: {
                run: (...p) =>
                    exec("update embed_logs set status=?,err=? where id=?", p),
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
            get_stream_telemetry: {
                all: (limit = 50, offset = 0) =>
                    many(
                        "select id,user_id,embedding_mode,duration_ms,memory_ids,query,ts from stream_telemetry order by ts desc limit ? offset ?",
                        [limit, offset],
                    ),
            },
            all_mem_by_user: {
                all: (user_id, limit, offset) => {
                    const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                    if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                        const msg = `Tenant-scoped read (all_mem_by_user) requires user_id when OM_STRICT_TENANT=true`;
                        logger.error({ component: 'DB' }, `[DB] ${msg}`);
                        throw new Error(msg);
                    }
                    return many(
                        "select * from memories where user_id=? order by created_at desc limit ? offset ?",
                        [user_id, limit, offset],
                    );
                },
            },
            ins_stream_telemetry: {
                run: (id: string, user_id: string | null, embedding_mode: string | null, duration_ms: number, memory_ids: string, query: string, ts: number) =>
                    // Enforce tenant scoping on telemetry insert when OM_STRICT_TENANT is enabled
                    // to avoid unscoped telemetry being written in strict tenant modes.
                    (() => {
                        const strict = (process.env.OM_STRICT_TENANT || '').toLowerCase() === 'true';
                        if (strict && (user_id === null || user_id === undefined || user_id === '')) {
                            const msg = `Tenant-scoped write (ins_stream_telemetry) requires user_id when OM_STRICT_TENANT=true`;
                            logger.error({ component: 'DB' }, `[DB] ${msg}`);
                            throw new Error(msg);
                        }
                        return exec("insert or replace into stream_telemetry(id,user_id,embedding_mode,duration_ms,memory_ids,query,ts) values(?,?,?,?,?,?,?)", [id, user_id, embedding_mode, duration_ms, memory_ids, query, ts]);
                    })(),
            },
            ins_user: {
                run: (...p) =>
                    exec(
                        "insert or replace into users(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?)",
                        p,
                    ),
            },
            get_user: {
                get: (user_id) =>
                    one("select * from users where user_id=?", [user_id]),
            },
            upd_user_summary: {
                run: (...p) =>
                    exec(
                        "update users set summary=?,reflection_count=reflection_count+1,updated_at=? where user_id=?",
                        p,
                    ),
            },
        };
    }

    // Mark initialized for the backend/path so subsequent calls are no-ops
    _initialized_db_path = desiredPath;
}

/**
 * Close any active DB clients and reset initialization state.
 * Tests should call this to ensure Postgres clients and SQLite handles are
 * cleanly released between cases. This function is best-effort and will
 * swallow errors while logging warnings.
 */
export async function closeDb(): Promise<void> {
    // Close Postgres client/pool if present
    try {
        if (_pgClient) {
            try {
                // If this is a node `pg` client from pool.connect(), release it
                if (typeof _pgClient.release === 'function') {
                    try { _pgClient.release(); } catch (e) { /* ignore */ }
                }
                // If client exposes end/close, await it
                if (typeof _pgClient.end === 'function') {
                    await _pgClient.end();
                } else if (typeof _pgClient.close === 'function') {
                    await _pgClient.close();
                }
            } catch (e) {
                logger.warn({ component: 'DB', err: e }, '[DB] Error while closing Postgres client');
            }
            _pgClient = null;
        }
        if (_pgPool) {
            try {
                if (typeof _pgPool.end === 'function') await _pgPool.end();
            } catch (e) {
                logger.warn({ component: 'DB', err: e }, '[DB] Error while closing Postgres pool');
            }
            _pgPool = null;
        }
    } catch (e) {
        logger.warn({ component: 'DB', err: e }, '[DB] Unexpected error during Postgres shutdown');
    }

    // Close SQLite DB handle if present
    try {
        if (_sqliteDb) {
            try {
                if (typeof (_sqliteDb as any).close === 'function') {
                    // Bun sqlite `Database.close()` is synchronous; wrap in Promise.resolve
                    await Promise.resolve((_sqliteDb as any).close());
                }
            } catch (e) {
                logger.warn({ component: 'DB', err: e }, '[DB] Error while closing SQLite handle');
            }
            _sqliteDb = null;
        }
    } catch (e) {
        logger.warn({ component: 'DB', err: e }, '[DB] Unexpected error during SQLite shutdown');
    }

    // Reset initialized path so subsequent initDb() re-initializes
    _initialized_db_path = null;
}


export const log_maint_op = async (
    type: "decay" | "reflect" | "consolidate",
    cnt = 1,
) => {
    try {
        await run_async("insert into stats(type,count,ts) values(?,?,?)", [
            type,
            cnt,
            Date.now(),
        ]);
    } catch (e) {
        logger.error({ component: "DB", err: e, operation: "log_maint_op" }, "[DB] Maintenance log error");
    }
};

export { q, transaction, all_async, get_async, run_async, memories_table, initDb };
