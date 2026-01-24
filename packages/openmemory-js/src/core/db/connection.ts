/**
 * @file Database Connection Management
 * Handles connection lifecycle, context management, and connection pooling.
 * Extracted from db_access.ts for better memory management.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { Database } from "bun:sqlite";
import { Pool, PoolClient } from "pg";

import { logger as dbLogger } from "../../utils/logger";
import { env } from "../cfg";
import { validateTableName } from "../security";

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
export const safeLog = (level: "debug" | "info" | "warn" | "error", msg: string, meta?: any) => {
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

export const get_stmt_cache = () => {
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

export const get_lifecycle_lock = () => {
    const cid = getContextId();
    if (!lifecycle_locks.has(cid)) lifecycle_locks.set(cid, Promise.resolve());
    return lifecycle_locks.get(cid)!;
};

export const get_tx_lock = () => {
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

let pg: Pool | null = null;
export let hasVector = false;

const pool = (dbOverride?: string) =>
    new Pool({
        user: env.pgUser,
        host: env.pgHost,
        database: dbOverride || env.pgDb,
        password: env.pgPassword,
        port: env.pgPort,
        ssl: env.pgSsl === "require" ? { rejectUnauthorized: false } : env.pgSsl === "disable" ? false : undefined,
        max: env.pgMax || 20,
        idleTimeoutMillis: env.pgIdleTimeout || 30000,
        connectionTimeoutMillis: env.pgConnTimeout || 2000,
    });

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

// Import init function from initialization module
import { init } from './initialization';

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
    dbLogger.info(`[DB] Closed and cleaned up. (Worker: ${cid})`);
}

// Export pg for use in other modules
export { pg };