/**
 * @file Database Mappers
 * Row mapping, data transformation, and parameter normalization.
 * Extracted from db_access.ts for better memory management.
 */
import { type SqlParams } from "../dbUtils";
import { getIsPg } from "./connection";

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

export const normalizeParams = (params: SqlParams, isPg: boolean): any[] => {
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