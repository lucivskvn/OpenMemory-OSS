/**
 * @file Database Access Layer
 * Low-level database primitives, connection management, and query wrappers.
 * Extracted from db.ts to resolve circular dependencies with repositories.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { Database } from "bun:sqlite";
import { Pool, PoolClient } from "pg";

import { logger as dbLogger } from "../utils/logger";
import { env } from "./cfg";
import { validateTableName } from "./security";
import { applySqlUser, type SqlParams, type SqlValue } from "./dbUtils";
import { queryPerformanceMonitor, withQueryMonitoring } from "./queryOptimizer";

// Validate table names on module load to prevent SQL injection via config
try {
    validateTableName(env.pgSchema);
    validateTableName(env.pgTable);
    validateTableName(env.vectorTable);
    validateTableName(env.usersTable);
} catch (e) {
    dbLogger.error("🚨 [SECURITY] Critical Configuration Error: Invalid table/schema name detected.");
    dbLogger.error("   Table names must only contain alphanumeric characters and underscores.");
    process.exit(1);
}

dbLogger.debug(`[DB] Module loading (Worker: ${Bun.env.TEST_WORKER_ID || "main"}, Env: ${env.isTest ? "test" : "prod"})`);

/**
 * Interface mapping for repository early binding.
 * Allows core modules to access high-level query methods without circular imports.
 * Uses index signature for flexibility; actual types are enforced in db.ts QType.
 */
export interface RepositoryMap {
    memories: any;
    transaction: any;
    users: any;
    vectors: any;
    waypoints: any;
    facts: any;
    edges: any;
    sources: any;
    maintenance: any;
    stats: any;
    [key: string]: any;
}

/**
 * Early binding for high-level repository methods (q.memories.get, etc.)
 */
export const q = {} as RepositoryMap;

// Safe logging helper for paths that might be called during early initialization
const safeLog = (level: "debug" | "info" | "warn" | "error", msg: string, meta?: any) => {
    try {
        if (dbLogger) {
            switch (level) {
                case "debug": dbLogger.debug(msg, meta); break;
                case "info": dbLogger.info(msg, meta); break;
                case "warn": dbLogger.warn(msg, meta); break;
                case "error": dbLogger.error(msg, meta); break;
            }
        } else {
            console.log(`[DB][FALLBACK][${level.toUpperCase()}] ${msg}`, meta || "");
        }
    } catch {
        console.log(`[DB][FALLBACK][${level.toUpperCase()}] ${msg}`, meta || "");
    }
};

// Thread-local state
const dbs = new Map<string, Database>();
const readyStates = new Map<string, boolean>();
const readyPromises = new Map<string, Promise<void> | null>();
const stmt_caches = new Map<string, Map<string, { stmt: ReturnType<Database["prepare"]>; lastUsed: number }>>();
const MAX_CACHE_SIZE = 100;

const get_stmt_cache = () => {
    const key = `${env.dbPath || ":memory:"}_${getContextId()}`;
    let c = stmt_caches.get(key);
    if (!c) {
        c = new Map();
        stmt_caches.set(key, c);
    }

    if (c.size > MAX_CACHE_SIZE) {
        const entries = Array.from(c.entries())
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE + 1);
        toRemove.forEach(([k]) => c!.delete(k));
    }

    return c;
};


const lifecycle_locks = new Map<string, Promise<void>>();
const tx_locks = new Map<string, Promise<void>>();

/**
 * Unique identifier for the current execution context (Worker or Process).
 * Used for connection isolation and caching.
 */
export const getContextId = () => {
    // Priority: Explicit worker ID > Bun worker ID > Process PID
    return Bun.env.TEST_WORKER_ID || (globalThis as any).Bun?.workerId?.toString() || (typeof process !== "undefined" ? String(process.pid) : "0");
};

const get_lifecycle_lock = () => {
    const cid = getContextId();
    if (!lifecycle_locks.has(cid)) lifecycle_locks.set(cid, Promise.resolve());
    return lifecycle_locks.get(cid)!;
};

const get_tx_lock = () => {
    const cid = getContextId();
    if (!tx_locks.has(cid)) tx_locks.set(cid, Promise.resolve());
    return tx_locks.get(cid)!;
};
export const txStorage = new AsyncLocalStorage<{ depth: number; cli?: PoolClient }>();


/**
 * Checks if the current environment is configured for PostgreSQL.
 */
export const getIsPg = () => {
    return env.metadataBackend === "postgres" || env.vectorBackend === "postgres";
};

/**
 * Converts `? ` placeholders to `$N` for PostgreSQL compatibility.
 */
export function convertPlaceholders(sql: string): string {
    if (!getIsPg()) return sql;

    let i = 0;
    let inString = false;
    let result = '';

    for (let j = 0; j < sql.length; j++) {
        const char = sql[j];
        const nextChar = sql[j + 1];

        if (char === "'" && sql[j - 1] !== '\\') {
            inString = !inString;
            result += char;
        } else if (char === '?' && !inString) {
            if (nextChar === '?') {
                result += '??';
                j++; // Skip next ?
            } else {
                result += `$${++i}`;
            }
        } else {
            result += char;
        }
    }

    return result;
}

const CAMEL_CACHE = new Map<string, string>();
const toCamel = (s: string) => {
    let cached = CAMEL_CACHE.get(s);
    if (cached) return cached;
    cached = s.replace(/([-_][a-z])/ig, ($1) => $1.toUpperCase().replace('-', '').replace('_', ''));
    if (CAMEL_CACHE.size < 1000) CAMEL_CACHE.set(s, cached);
    return cached;
};

const DIRECT_KEYS = new Set(["id", "uid", "sid", "tid", "tag", "key", "val", "type", "ok", "success", "status", "data", "count", "cnt", "gpu", "tier", "dim", "cache", "version", "role", "note", "segment", "simhash", "salience", "err", "model", "confidence", "weight"]);

const JSON_COL_SET = new Set(["metadata", "tags", "details", "config", "payload", "weights", "biases", "events", "conditions"]);
const TIMESTAMP_COL_SET = new Set(["_at", "valid_", "last_updated", "next_retry", "last_triggered", "window_start", "last_request", "timestamp", "ts", "created_at", "updated_at", "last_seen_at"]);

/**
 * High-performance row mapper. 
 * Converts DB rows to camelCase objects and parses JSON/Timestamps.
 */
export const mapRow = (row: Record<string, any> | null): any => {
    if (!row) return row;

    const mapped: any = {};
    const entries = Object.entries(row);

    for (let i = 0; i < entries.length; i++) {
        const [k, val] = entries[i];
        let finalizedVal = val;

        // Optimized column type detection
        if (typeof val === "string" && val.length > 0) {
            // Check for JSON - O(1) lookup via Set by checking if column contains any indicator
            // Since Set check is fast, we can check a few common indicators or the whole key
            let isJson = false;
            // Iterate Set once
            for (const indicator of JSON_COL_SET) {
                if (k.includes(indicator)) {
                    isJson = true;
                    break;
                }
            }

            if (isJson) {
                const firstChar = val[0];
                if (firstChar === "{" || firstChar === "[") {
                    try { finalizedVal = JSON.parse(val); } catch { /* ignore */ }
                }
            } else {
                let isTimestamp = false;
                for (const indicator of TIMESTAMP_COL_SET) {
                    if (k.includes(indicator)) {
                        isTimestamp = true;
                        break;
                    }
                }
                if (isTimestamp && val.length > 5) {
                    const num = Number(val);
                    if (!Number.isNaN(num)) finalizedVal = num;
                }
            }
        }

        // Key mapping
        if (DIRECT_KEYS.has(k)) {
            mapped[k] = finalizedVal;
        } else if (k.indexOf("_") !== -1) {
            mapped[toCamel(k)] = finalizedVal;
        } else {
            mapped[k] = finalizedVal;
        }
    }

    return mapped;
};

const normalizeParams = (params: SqlParams, isPg: boolean): any[] => {
    return params.map((v) => {
        if (v === undefined) return null;
        if (v instanceof Uint8Array || Buffer.isBuffer(v)) return v;

        // SQLite only accepts Uint8Array/Buffer for blobs. 
        if (!isPg && Array.isArray(v)) {
            if (v.length > 0 && typeof v[0] === "number" && v.some(n => !Number.isInteger(n))) {
                // Heuristic for vectors (floats)
                return new Uint8Array(new Float32Array(v).buffer);
            }
            return JSON.stringify(v);
        }
        if (!isPg && typeof v === "object" && v !== null) return JSON.stringify(v);
        return v;
    });
};

async function execRes(sql: string, params: SqlParams) {
    const isPg = getIsPg();
    const strictP = normalizeParams(params, isPg);

    if (env.verbose) {
        dbLogger.debug(`[DB] ${isPg ? "PG" : "SQ"}: ${sql}`, { params: strictP });
    }

    if (isPg) {
        const finalSql = convertPlaceholders(sql);
        const client = txStorage.getStore()?.cli || pg!;
        if (!client) throw new Error("PG accessible but client is null");
        return await client.query(finalSql, strictP as any[]);
    } else {
        const db = await get_sq_db();
        const stmt_cache = get_stmt_cache();
        let cached = stmt_cache.get(sql);
        if (!cached) {
            const stmt = db.prepare(sql);
            cached = { stmt, lastUsed: Date.now() };
            stmt_cache.set(sql, cached);
        } else {
            cached.lastUsed = Date.now();
        }

        const changes = cached.stmt.run(...(strictP as any[]));
        return { rowCount: changes.changes, rows: [] };
    }
}

async function execAll<T>(sql: string, params: SqlParams): Promise<T[]> {
    const isPg = getIsPg();
    const strictP = normalizeParams(params, isPg);

    if (isPg) {
        const client = txStorage.getStore()?.cli || pg!;
        const finalSql = convertPlaceholders(sql);
        const res = await client.query(finalSql, strictP as any[]);
        return res.rows.map(mapRow) as T[];
    } else {
        const db = await get_sq_db();
        const stmt_cache = get_stmt_cache();
        let cached = stmt_cache.get(sql);
        if (!cached) {
            const stmt = db.prepare(sql);
            cached = { stmt, lastUsed: Date.now() };
            stmt_cache.set(sql, cached);
        } else {
            cached.lastUsed = Date.now();
        }

        const rows = cached.stmt.all(...(strictP as any[]));
        return rows.map((r) => mapRow(r as Record<string, unknown>)) as T[];
    }
}

/**
 * Executes a query that modifies data (INSERT/UPDATE/DELETE).
 * 
 * @param sql - The SQL query with '?' placeholders.
 * @param params - Array of parameters to bind.
 * @returns The number of affected rows.
 */
export async function runAsync(sql: string, params: SqlParams = []): Promise<number> {
    await waitReady();
    
    return withQueryMonitoring(sql, params, async () => {
        const start = Date.now();
        try {
            const res = await execRes(sql, params);
            const duration = Date.now() - start;
            if (duration > 1000) {
                dbLogger.warn("[DB] Slow query detected", {
                    sql: sql.substring(0, 100),
                    duration,
                    params: params.length,
                });
            }
            return res.rowCount || 0;
        } catch (err) {
            dbLogger.error("[DB] Query failed", {
                sql,
                params,
                error: err,
                dbPath: env.dbPath,
            });
            throw err;
        }
    });
}

/**
 * Cross-platform Upsert helper.
 * Handles INSERT OR REPLACE (SQLite) vs INSERT ... ON CONFLICT (Postgres).
 * @param table Table name (use TABLES proxy)
 * @param idColumns Array of column names that form the unique/primary key
 * @param row Object containing the data to insert/update
 */
export async function upsertAsync(table: string, idColumns: string[], row: Record<string, any>): Promise<number> {
    await waitReady();
    const isPg = getIsPg();
    const keys = Object.keys(row);
    if (keys.length === 0) return 0;

    const cols = keys.map(k => isPg ? `"${k}"` : k).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const params = keys.map(k => row[k]);

    if (!isPg) {
        // SQLite
        const sql = `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`;
        return await runAsync(sql, params);
    } else {
        // Postgres
        const conflictTarget = idColumns.map(k => `"${k}"`).join(", ");
        const updates = keys
            .filter(k => !idColumns.includes(k))
            .map(k => `"${k}"=EXCLUDED."${k}"`)
            .join(", ");

        let sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflictTarget}) `;
        if (updates.length > 0) {
            sql += `DO UPDATE SET ${updates}`;
        } else {
            sql += `DO NOTHING`;
        }
        return await runAsync(sql, params);
    }
}

/**
 * Executes a query and returns a single row.
 * 
 * @param sql - The SQL query with '?' placeholders.
 * @param params - Array of parameters to bind.
 * @returns The first matching row, mapped to a normalized object, or undefined.
 */
export async function getAsync<T = unknown>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    await waitReady();
    
    return withQueryMonitoring(sql, params, async () => {
        const rows = await execAll<T>(sql, params);
        return rows[0] as T;
    });
}

/**
 * Executes a query and returns all matching rows.
 * 
 * @param sql - The SQL query with '?' placeholders.
 * @param params - Array of parameters to bind.
 * @returns An array of mapped normalized objects.
 */
export async function allAsync<T = unknown>(sql: string, params: SqlParams = []): Promise<T[]> {
    await waitReady();
    
    return withQueryMonitoring(sql, params, async () => {
        return await execAll<T>(sql, params);
    });
}

/**
 * Asynchronously iterates over query results.
 * For SQLite, this uses a persistent cursor to minimize memory usage.
 * For PostgreSQL, currently fetches all rows (buffer) - deep-dive recommended for true cursor support.
 * 
 * @param sql - The SQL query with '?' placeholders.
 * @param p - Array of parameters to bind.
 */
export async function* iterateAsync<T = unknown>(sql: string, p: SqlParams = []): AsyncIterable<T> {
    await waitReady();
    const isPg = getIsPg();

    if (isPg) {
        // PG Note: True cursors require a dedicated client and transaction.
        // For now, we use a buffered approach for simplicity and consistency with current usage.
        const rows = (await allAsync(sql, p)) as T[];
        for (const row of rows) yield row;
    } else {
        const d = await get_sq_db();
        const strictP = normalizeParams(p, false);

        try {
            dbLogger.debug(`[DB] Iterating (non-cached): ${sql.substring(0, 100)}...`, { paramCount: strictP.length });

            const stmt = d.prepare(sql);
            const iter = stmt.iterate(...(strictP as any[]));
            for (const row of iter) {
                yield mapRow(row as Record<string, unknown>) as T;
            }
        } catch (error) {
            dbLogger.error(`[DB] IterateAsync Error: ${sql}`, {
                error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
                params: Array.isArray(p) ? p : [p],
            });
            throw error;
        }
    }
}

// User-scoped helpers
export const runUser = async (sql: string, params: SqlParams, userId: string | null | undefined): Promise<number> => {
    const { sql: s, params: p } = applySqlUser(sql, params, userId);
    return await runAsync(s, p);
};

export const getUser = async <T = unknown>(sql: string, params: SqlParams, userId: string | null | undefined): Promise<T | undefined> => {
    const { sql: s, params: p } = applySqlUser(sql, params, userId);
    return await getAsync<T>(s, p);
};

export const allUser = async <T = unknown>(sql: string, params: SqlParams, userId: string | null | undefined): Promise<T[]> => {
    const { sql: s, params: p } = applySqlUser(sql, params, userId);
    return await allAsync<T>(s, p);
};

// ... WaitReady, TABLES, etc ...
export async function waitReady() {
    if (txStorage.getStore()) return;
    if (readyStates.get(getContextId())) return;
    let p = readyPromises.get(getContextId());
    if (!p) {
        p = init();
        readyPromises.set(getContextId(), p);
    }
    await p;
    readyPromises.set(getContextId(), null);
}

let _tableCache: Record<string, string> | null = null;
const getTable = (key: keyof typeof TABLES): string => {
    if (_tableCache && _tableCache[key]) return _tableCache[key];
    if (!_tableCache) _tableCache = {};

    const isPg = getIsPg();
    const rawTable = (() => {
        if (!isPg) {
            // SQLite Names (Simple)
            switch (key) {
                case "memories": return "memories";
                case "vectors": return env.vectorTable || "vectors";
                case "waypoints": return "waypoints";
                case "users": return "users";
                case "stats": return "stats";
                case "maint_logs": return "maint_logs";
                case "embed_logs": return "embed_logs";
                case "temporal_facts": return "temporal_facts";
                case "temporal_edges": return "temporal_edges";
                case "learned_models": return "learned_models";
                case "source_configs": return "source_configs";
                case "api_keys": return "api_keys";
                case "encryption_keys": return "encryption_keys";
                case "audit_logs": return "audit_logs";
                case "webhooks": return "webhooks";
                case "webhook_logs": return "webhook_logs";
                case "system_locks": return "system_locks";
                case "rate_limits": return "rate_limits";
                case "config": return "config";
                case "feature_flags": return "feature_flags";
                default: return key;
            }
        }

        // Postgres Names (Namespaced)
        switch (key) {
            case "memories": return env.pgTable || "openmemory_memories";
            case "vectors": return `${env.pgTable || "openmemory_memories"}_vectors`;
            case "waypoints": return `${env.pgTable || "openmemory_memories"}_waypoints`;
            case "users": return env.usersTable || "users";
            case "stats": return `${env.pgTable || "openmemory_memories"}_stats`;
            case "maint_logs": return `${env.pgTable || "openmemory_memories"}_maint_logs`;
            case "embed_logs": return `${env.pgTable || "openmemory_memories"}_embed_logs`;
            case "temporal_facts": return `${env.pgTable || "openmemory_memories"}_temporal_facts`;
            case "temporal_edges": return `${env.pgTable || "openmemory_memories"}_temporal_edges`;
            case "learned_models": return `${env.pgTable || "openmemory_memories"}_learned_models`;
            case "source_configs": return `${env.pgTable || "openmemory_memories"}_source_configs`;
            case "api_keys": return `${env.pgTable || "openmemory_memories"}_api_keys`;
            case "encryption_keys": return `${env.pgTable || "openmemory_memories"}_encryption_keys`;
            case "audit_logs": return `${env.pgTable || "openmemory_memories"}_audit_logs`;
            case "webhooks": return `${env.pgTable || "openmemory_memories"}_webhooks`;
            case "webhook_logs": return `${env.pgTable || "openmemory_memories"}_webhook_logs`;
            case "system_locks": return "system_locks";
            case "rate_limits": return `${env.pgTable || "openmemory_memories"}_rate_limits`;
            case "config": return `${env.pgTable || "openmemory_memories"}_config`;
            case "feature_flags": return `${env.pgTable || "openmemory_memories"}_feature_flags`;
            default: return key;
        }
    })();

    const name = validateTableName(rawTable);
    _tableCache[key] = isPg ? `"${env.pgSchema}"."${name}"` : name;
    return _tableCache[key];
};

export const TABLES = {
    get memories() { return getTable("memories"); },
    get vectors() { return getTable("vectors"); },
    get waypoints() { return getTable("waypoints"); },
    get users() { return getTable("users"); },
    get stats() { return getTable("stats"); },
    get maint_logs() { return getTable("maint_logs"); },
    get embed_logs() { return getTable("embed_logs"); },
    get temporal_facts() { return getTable("temporal_facts"); },
    get temporal_edges() { return getTable("temporal_edges"); },
    get learned_models() { return getTable("learned_models"); },
    get source_configs() { return getTable("source_configs"); },
    get api_keys() { return getTable("api_keys"); },
    get encryption_keys() { return getTable("encryption_keys"); },
    get audit_logs() { return getTable("audit_logs"); },
    get webhooks() { return getTable("webhooks"); },
    get webhook_logs() { return getTable("webhook_logs"); },
    get system_locks() { return getTable("system_locks"); },
    get rate_limits() { return getTable("rate_limits"); },
    get config() { return getTable("config"); },
    get feature_flags() { return getTable("feature_flags"); },
};

let pg: Pool | null = null;
export let hasVector = false;

import { connectionPoolOptimizer } from "./queryOptimizer";
import { initializeIndexes } from "./indexOptimizer";

const pool = (dbOverride?: string) => {
    const optimizedConfig = connectionPoolOptimizer.getOptimizedPoolConfig();
    
    return new Pool({
        user: env.pgUser,
        host: env.pgHost,
        database: dbOverride || env.pgDb,
        password: env.pgPassword,
        port: env.pgPort,
        ssl: env.pgSsl === "require" ? { rejectUnauthorized: false } : env.pgSsl === "disable" ? false : undefined,
        max: optimizedConfig.maxConnections,
        idleTimeoutMillis: optimizedConfig.idleTimeout,
        connectionTimeoutMillis: optimizedConfig.connectionTimeout,
    });
};

if (getIsPg()) {
    pg = pool();
    pg.on("error", (err) => dbLogger.error("[DB] Unexpected PG error", { error: err }));
}

export const get_sq_db = async () => {
    const db_path = env.dbPath || ":memory:";
    const cacheKey = `${db_path}_${getContextId()}`;

    let d = dbs.get(cacheKey);
    if (d) return d;
    dbLogger.info(`[DB] Opening connection to: ${db_path} (Context: ${getContextId()})`);

    if (db_path !== ":memory:") {
        const dir = path.dirname(db_path);
        // Bun native way to ensure directory exists
        try {
            // Use mkdir command for cross-platform directory creation
            const isWindows = process.platform === "win32";
            if (isWindows) {
                const proc = Bun.spawn(["cmd", "/c", "mkdir", dir.replace(/\//g, "\\")], {
                    stderr: "ignore"
                });
                await proc.exited;
            } else {
                const proc = Bun.spawn(["mkdir", "-p", dir], {
                    stderr: "ignore"
                });
                await proc.exited;
            }
        } catch { /* ignore */ }
    }
    d = new Database(db_path, { create: true });
    if (db_path !== ":memory:") {
        const result = d.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode: string };
        if (result.journal_mode !== 'wal') {
            dbLogger.warn(`[DB] Failed to enable WAL mode. Got: ${result.journal_mode}`);
        }
        d.exec("PRAGMA synchronous=NORMAL");
        d.exec("PRAGMA foreign_keys = ON;");
    }
    dbs.set(cacheKey, d);
    return d;
};

async function connectWithRetry(maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await pg!.query("SELECT 1");
            return;
        } catch (err: unknown) {
            if (i === maxRetries - 1) throw err;
            const delay = Math.pow(2, i) * 1000;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ... Init function (simplified copy from db.ts but complete) ...
export const init = async () => {
    const cid = getContextId();
    if (readyStates.get(cid)) return;

    const release = await (async () => {
        let r: () => void;
        const p = new Promise<void>((resolve) => { r = resolve; });
        const old = lifecycle_locks.get(cid) || Promise.resolve();
        lifecycle_locks.set(cid, p);
        await Promise.race([old, new Promise((_, reject) => setTimeout(() => reject(new Error(`DB Lock Timeout (init)`)), 5000))]).catch(e => dbLogger.warn(e instanceof Error ? e.message : String(e)));
        return r!;
    })();

    try {
        if (readyStates.get(cid)) return;

        // Reset local caches to avoid stale table names or state
        _tableCache = null;

        if (getIsPg()) {
            const client = await pg!.connect();
            try {
                await client.query("BEGIN");
                dbLogger.info(`[DB] Creating tables in Postgres (Schema: ${env.pgSchema})...`);

                // Core Tables
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.memories} (id text PRIMARY KEY, user_id text, segment integer DEFAULT 0, content text NOT NULL, simhash text, primary_sector text NOT NULL, tags text, metadata text, created_at bigint, updated_at bigint, last_seen_at bigint, salience double precision, decay_lambda double precision, version integer DEFAULT 1, mean_dim integer, mean_vec bytea, compressed_vec bytea, feedback_score double precision DEFAULT 0, generated_summary text, coactivations integer DEFAULT 0, encryption_key_version integer DEFAULT 1)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.vectors} (id text, sector text, user_id text, v bytea, dim integer NOT NULL, metadata text, PRIMARY KEY(id, sector))`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.waypoints} (src_id text, dst_id text NOT NULL, user_id text, weight double precision NOT NULL, created_at bigint, updated_at bigint, PRIMARY KEY(src_id, dst_id, user_id))`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.embed_logs} (id text PRIMARY KEY, user_id text, model text, status text, ts bigint, err text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.users} (user_id text PRIMARY KEY, summary text, reflection_count integer DEFAULT 0, created_at bigint, updated_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.stats} (id serial PRIMARY KEY, type text NOT NULL, count integer DEFAULT 1, ts bigint NOT NULL, user_id text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.maint_logs} (id serial PRIMARY KEY, op text NOT NULL, status text NOT NULL, details text, ts bigint NOT NULL, user_id text)`);

                // Temporal Graph
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.temporal_facts} (id text PRIMARY KEY, user_id text, subject text NOT NULL, predicate text NOT NULL, object text NOT NULL, valid_from bigint NOT NULL, valid_to bigint, confidence double precision NOT NULL, last_updated bigint NOT NULL, metadata text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.temporal_edges} (id text PRIMARY KEY, user_id text, source_id text NOT NULL, target_id text NOT NULL, relation_type text NOT NULL, valid_from bigint NOT NULL, valid_to bigint, weight double precision NOT NULL, metadata text, last_updated bigint)`);

                // System & Auth
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.learned_models} (user_id text PRIMARY KEY, weights text, biases text, version integer DEFAULT 1, updated_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.source_configs} (user_id text, type text, config text NOT NULL, status text DEFAULT 'enabled', created_at bigint, updated_at bigint, PRIMARY KEY(user_id, type))`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.api_keys} (key_hash text PRIMARY KEY, user_id text NOT NULL, role text NOT NULL DEFAULT 'user', note text, created_at bigint, updated_at bigint, expires_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.encryption_keys} (id text PRIMARY KEY, old_version integer NOT NULL, new_version integer NOT NULL, status text DEFAULT 'pending', started_at bigint, completed_at bigint, error text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.audit_logs} (id text PRIMARY KEY, user_id text, action text NOT NULL, resource_type text NOT NULL, resource_id text, ip_address text, user_agent text, metadata text, timestamp bigint not null)`);

                // Webhooks & Scaling
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.webhooks} (id text PRIMARY KEY, user_id text NOT NULL, url text NOT NULL, events text NOT NULL, secret text NOT NULL, status text DEFAULT 'active', retry_count integer DEFAULT 0, last_triggered bigint, created_at bigint not null, updated_at bigint not null)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.webhook_logs} (id text PRIMARY KEY, webhook_id text not null, event_type text not null, payload text not null, status text not null, response_code integer, response_body text, attempt_count integer DEFAULT 1, next_retry bigint, created_at bigint not null, completed_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.system_locks} (lock_key text PRIMARY KEY, token text, expires_at bigint)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.rate_limits} (key text PRIMARY KEY, window_start bigint not null, request_count integer DEFAULT 0, cost_units integer DEFAULT 0, last_request bigint not null)`);

                // Configuration & Flags
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.config} (key text PRIMARY KEY, value text not null, type text not null, description text, updated_at bigint not null, updated_by text)`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${TABLES.feature_flags} (name text PRIMARY KEY, enabled boolean DEFAULT false, rollout_percentage integer DEFAULT 0, conditions text, created_at bigint, updated_at bigint)`);

                // Indices for Postgres
                await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_user ON ${TABLES.memories}(user_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_sector ON ${TABLES.memories}(primary_sector)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_ts ON ${TABLES.memories}(last_seen_at DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_metadata ON ${TABLES.memories} USING GIN(metadata) WHERE metadata IS NOT NULL`).catch(() => { });
                await client.query(`CREATE INDEX IF NOT EXISTS idx_vectors_user ON ${TABLES.vectors}(user_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON ${TABLES.temporal_facts}(user_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_temporal_subject ON ${TABLES.temporal_facts}(subject)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON ${TABLES.rate_limits}(window_start)`);

                await client.query("COMMIT");
            } catch (e) {
                await client.query("ROLLBACK");
                throw e;
            } finally {
                client.release();
            }
        } else {
            const d = await get_sq_db();
            const dbPath = env.dbPath || ":memory:";
            dbLogger.info(`[DB] Init SQLite at ${dbPath} (isPg: ${getIsPg()})`);
            const tx = d.transaction(() => {
                dbLogger.info(`[DB] Creating tables in ${dbPath}...`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.memories} (id text PRIMARY KEY, user_id text, segment integer DEFAULT 0, content text NOT NULL, simhash text, primary_sector text NOT NULL, tags text, metadata text, created_at integer, updated_at integer, last_seen_at integer, salience real, decay_lambda real, version integer DEFAULT 1, mean_dim integer, mean_vec blob, compressed_vec blob, feedback_score real DEFAULT 0, generated_summary text, coactivations integer DEFAULT 0, encryption_key_version integer DEFAULT 1)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.vectors} (id text, sector text, user_id text, v blob, dim integer NOT NULL, metadata text, PRIMARY KEY(id, sector))`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.waypoints} (src_id text, dst_id text NOT NULL, user_id text, weight real NOT NULL, created_at integer, updated_at integer, PRIMARY KEY(src_id, dst_id, user_id))`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.embed_logs} (id text PRIMARY KEY, user_id text, model text, status text, ts integer, err text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.users} (user_id text PRIMARY KEY, summary text, reflection_count integer DEFAULT 0, created_at integer, updated_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.stats} (id integer PRIMARY KEY AUTOINCREMENT, type text NOT NULL, count integer DEFAULT 1, ts integer NOT NULL, user_id text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.maint_logs} (id integer PRIMARY KEY AUTOINCREMENT, op text NOT NULL, status text NOT NULL, details text, ts integer NOT NULL, user_id text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.temporal_facts} (id text PRIMARY KEY, user_id text, subject text NOT NULL, predicate text NOT NULL, object text NOT NULL, valid_from integer NOT NULL, valid_to integer, confidence real NOT NULL, last_updated integer NOT NULL, metadata text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.temporal_edges} (id text PRIMARY KEY, user_id text, source_id text NOT NULL, target_id text NOT NULL, relation_type text NOT NULL, valid_from integer NOT NULL, valid_to integer, weight real NOT NULL, metadata text, last_updated integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.learned_models} (user_id text PRIMARY KEY, weights text, biases text, version integer DEFAULT 1, updated_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.source_configs} (user_id text, type text, config text NOT NULL, status text DEFAULT 'enabled', created_at integer, updated_at integer, PRIMARY KEY(user_id, type))`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.api_keys} (key_hash text PRIMARY KEY, user_id text NOT NULL, role text NOT NULL DEFAULT 'user', note text, created_at integer, updated_at integer, expires_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.encryption_keys} (id text PRIMARY KEY, old_version integer NOT NULL, new_version integer NOT NULL, status text DEFAULT 'pending', started_at integer, completed_at integer, error text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.audit_logs} (id text PRIMARY KEY, user_id text, action text NOT NULL, resource_type text NOT NULL, resource_id text, ip_address text, user_agent text, metadata text, timestamp integer not null)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.webhooks} (id text PRIMARY KEY, user_id text NOT NULL, url text NOT NULL, events text NOT NULL, secret text NOT NULL, status text DEFAULT 'active', retry_count integer DEFAULT 0, last_triggered integer, created_at integer not null, updated_at integer not null)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.webhook_logs} (id text PRIMARY KEY, webhook_id text not null, event_type text not null, payload text not null, status text not null, response_code integer, response_body text, attempt_count integer DEFAULT 1, next_retry integer, created_at integer not null, completed_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.system_locks} (lock_key text PRIMARY KEY, token text, expires_at integer)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.rate_limits} (key text PRIMARY KEY, window_start integer not null, request_count integer DEFAULT 0, cost_units integer DEFAULT 0, last_request integer not null)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.config} (key text PRIMARY KEY, value text not null, type text not null, description text, updated_at integer not null, updated_by text)`);
                d.exec(`CREATE TABLE IF NOT EXISTS ${TABLES.feature_flags} (name text PRIMARY KEY, enabled boolean DEFAULT false, rollout_percentage integer DEFAULT 0, conditions text, created_at integer, updated_at integer)`);

                // Indices for SQLite
                d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_user ON ${TABLES.memories}(user_id)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_sector ON ${TABLES.memories}(primary_sector)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_ts ON ${TABLES.memories}(last_seen_at DESC)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_vectors_user ON ${TABLES.vectors}(user_id)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON ${TABLES.temporal_facts}(user_id)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_temporal_subject ON ${TABLES.temporal_facts}(subject)`);
                d.exec(`CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON ${TABLES.rate_limits}(window_start)`);

                // Auto-migrations catch-up
                try { d.exec(`ALTER TABLE ${TABLES.memories} ADD COLUMN generated_summary text`); } catch (e) { }
                try { d.exec(`ALTER TABLE ${TABLES.memories} ADD COLUMN coactivations integer DEFAULT 0`); } catch (e) { }
                try { d.exec(`ALTER TABLE ${TABLES.memories} ADD COLUMN encryption_key_version integer DEFAULT 1`); } catch (e) { }
                try { d.exec(`ALTER TABLE ${TABLES.vectors} ADD COLUMN metadata text`); } catch (e) { }
                dbLogger.info(`[DB] Tables Created in ${dbPath}`);
            });
            tx();
        }
        readyStates.set(cid, true);
        
        // Initialize optimized indexes after tables are created
        try {
            await initializeIndexes();
        } catch (e) {
            dbLogger.warn("[DB] Index initialization failed:", { error: e });
        }
    } catch (e) {
        dbLogger.error("[DB] Init failed", { error: e });
        throw e;
    } finally {
        release();
    }
};

export const transaction = {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
        await waitReady();
        const cid = getContextId();
        const store = txStorage.getStore();

        if (store) return await fn(); // Nested tx flattening

        let release: (() => void) | undefined;

        // Only lock for SQLite (single-writer constraint)
        // Postgres manages its own concurrency via MVCC and row-level locks
        if (!getIsPg()) {
            const cid = getContextId();

            // Queue Pattern: Append our "myLock" promise to the end of the chain.
            // We start when the *previous* promise resolves.
            // We resolve "myLock" (unlocking the NEXT guy) when our work is done (in finally).

            const previousLock = tx_locks.get(cid) || Promise.resolve();

            let unlockFn: () => void;
            const myLock = new Promise<void>((resolve) => { unlockFn = resolve; });

            // Handle previous failures gracefully so the chain doesn't perpetually break
            const safePrevious = previousLock.catch(() => { });

            // Append to chain
            tx_locks.set(cid, safePrevious.then(() => myLock));

            // Wait for our turn
            await safePrevious;

            release = unlockFn!;
        }

        try {
            return await txStorage.run({ depth: 1 }, async () => {
                if (getIsPg()) {
                    const client = await pg!.connect();
                    txStorage.getStore()!.cli = client as any;
                    try {
                        await client.query("BEGIN");
                        const res = await fn();
                        await client.query("COMMIT");
                        return res;
                    } catch (e) {
                        try { await client.query("ROLLBACK"); } catch { }
                        throw e;
                    } finally {
                        client.release();
                    }
                } else {
                    const db = await get_sq_db();
                    db.exec("BEGIN IMMEDIATE");
                    try {
                        const res = await fn();
                        db.exec("COMMIT");
                        return res;
                    } catch (e) {
                        try { db.exec("ROLLBACK"); } catch { }
                        throw e;
                    }
                }
            });
        } finally {
            if (release) release();
        }
    }
};

export async function closeDb() {
    const cid = getContextId();
    if (getIsPg()) { try { await pg?.end(); } catch { } pg = null; }
    else {
        // Close all SQLite connections for this context
        for (const [key, db] of dbs.entries()) {
            if (key.endsWith(`_${cid}`)) {
                try {
                    db.close();
                    // If in test mode and not explicitly keeping the DB, delete the file to prevent pollution
                    const [dbPath] = key.split(`_${cid}`);
                    if (env.isTest && !env.OM_KEEP_DB && dbPath !== ":memory:") {
                        try {
                            // Use Bun native file deletion for cross-platform compatibility
                            const isWindows = process.platform === "win32";
                            if (isWindows) {
                                const proc = Bun.spawn(["del", dbPath]);
                                await proc.exited;
                            } else {
                                const proc = Bun.spawn(["rm", dbPath]);
                                await proc.exited;
                            }
                        } catch { }
                    }
                } catch (e) {
                    dbLogger.warn(`[DB] Error closing ${key}`, { error: e });
                }
                dbs.delete(key);
            }
        }
    }
    stmt_caches.delete(`${env.dbPath || ":memory:"}_${cid}`);
    readyStates.set(cid, false);
    readyPromises.set(cid, null);
    lifecycle_locks.delete(cid);
    tx_locks.delete(cid);
    _tableCache = null; // Clear table name cache
    dbLogger.info(`[DB] Closed and cleaned up. (Worker: ${cid})`);
}


