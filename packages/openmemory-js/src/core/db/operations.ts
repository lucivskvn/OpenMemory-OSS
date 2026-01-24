/**
 * @file Database Operations
 * Core CRUD operations and query execution functions.
 * Extracted from db_access.ts for better memory management.
 */
import { logger as dbLogger } from "../../utils/logger";
import { env } from "../cfg";
import { applySqlUser, type SqlParams } from "../dbUtils";
import { 
    waitReady, 
    getIsPg, 
    get_sq_db, 
    get_stmt_cache, 
    txStorage, 
    pg 
} from "./connection";
import { mapRow, normalizeParams, convertPlaceholders } from "./mappers";

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
    const rows = await execAll<T>(sql, params);
    return rows[0] as T;
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
    return await execAll<T>(sql, params);
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