import { env } from "../core/cfg";
import { runAsync, TABLES } from "../core/db";
import { getRedisClient } from "../core/redis";
import { logger } from "./logger";

/**
 * Interface for distributed locking.
 */
export interface IDistributedLock {
    acquire(ttlMs?: number): Promise<boolean>;
    release(): Promise<void>;
}

/**
 * DistributedLock utility supporting multiple backends.
 * Uses a token-based approach to ensure only the owner can release the lock.
 */
export class DistributedLock implements IDistributedLock {
    private static memLocks = new Map<string, { token: string; expiresAt: number }>();
    private backend: "redis" | "postgres" | "sqlite" | "memory";
    private lockKey: string;
    private ownerToken: string;
    private isAcquired: boolean = false;

    constructor(name: string) {
        this.lockKey = `lock:${name}`;
        this.ownerToken = globalThis.crypto.randomUUID();

        // Determine backend based on configuration
        if (env.isTest && env.lockBackend === "auto") {
            this.backend = "memory";
            return;
        }

        if (env.lockBackend !== "auto") {
            this.backend = env.lockBackend as any;
        } else {
            // Auto detection
            if (env.vectorBackend === "valkey") {
                this.backend = "redis";
            } else if (env.metadataBackend === "postgres") {
                this.backend = "postgres";
            } else {
                this.backend = "sqlite";
            }
        }
    }

    /**
     * Attempts to acquire the lock.
     * @param ttlMs Time-to-live for the lock in milliseconds.
     * @returns True if acquired, false otherwise.
     */
    async acquire(ttlMs: number = 60000): Promise<boolean> {
        try {
            if (this.backend === "memory") {
                const now = Date.now();
                const current = DistributedLock.memLocks.get(this.lockKey);
                if (!current || current.expiresAt < now || current.token === this.ownerToken) {
                    DistributedLock.memLocks.set(this.lockKey, {
                        token: this.ownerToken,
                        expiresAt: now + ttlMs
                    });
                    this.isAcquired = true;
                    return true;
                }
                return false;
            }

            switch (this.backend) {
                case "redis":
                    return await this.acquireRedis(ttlMs);
                case "postgres":
                case "sqlite":
                    return await this.acquireSql(ttlMs);
            }
        } catch (e) {
            logger.error(`[LOCK] Failed to acquire lock ${this.lockKey}:`, {
                error: e,
            });
            return false;
        }
        return false;
    }

    /**
     * Releases the acquired lock.
     */
    async release(): Promise<void> {
        if (!this.isAcquired) return;

        try {
            if ((this.backend as any) === "memory") {
                const current = DistributedLock.memLocks.get(this.lockKey);
                if (current && current.token === this.ownerToken) {
                    DistributedLock.memLocks.delete(this.lockKey);
                }
                this.isAcquired = false;
                return;
            }

            switch (this.backend) {
                case "redis":
                    await this.releaseRedis();
                    break;
                case "postgres":
                case "sqlite":
                    await this.releaseSql();
                    break;
            }
            this.isAcquired = false;
        } catch (e) {
            logger.error(`[LOCK] Failed to release lock ${this.lockKey}:`, {
                error: e,
            });
        }
    }

    private async acquireRedis(ttlMs: number): Promise<boolean> {
        const client = getRedisClient();
        // Lua: If key doesn't exist OR value matches token, set it with TTL.
        const script = `
            if (redis.call('exists', KEYS[1]) == 0) or (redis.call('get', KEYS[1]) == ARGV[1]) then
                redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
                return 1
            else
                return 0
            end
        `;
        const res = await client.eval(script, 1, this.lockKey, this.ownerToken, ttlMs.toString());
        this.isAcquired = Number(res) === 1;
        return this.isAcquired;
    }

    private async releaseRedis(): Promise<void> {
        const client = getRedisClient();
        // Lua script to safely delete only if token matches
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        await client.eval(script, 1, this.lockKey, this.ownerToken);
    }

    private async acquireSql(ttlMs: number): Promise<boolean> {
        const now = Date.now();
        const expiresAt = now + ttlMs;
        const table = TABLES.system_locks;

        if (this.backend === "postgres") {
            // Ensure table exists
            await runAsync(`CREATE TABLE IF NOT EXISTS ${table} (lock_key TEXT PRIMARY KEY, token TEXT, expires_at BIGINT)`);
            const sql = `
                INSERT INTO ${table} (lock_key, token, expires_at) 
                VALUES (?, ?, ?) 
                ON CONFLICT (lock_key) DO UPDATE SET 
                    token = EXCLUDED.token,
                    expires_at = EXCLUDED.expires_at
                WHERE ${table}.token = EXCLUDED.token OR ${table}.expires_at < ?
            `;
            const rowCount = await runAsync(sql, [this.lockKey, this.ownerToken, expiresAt, now]);
            this.isAcquired = rowCount > 0;
        } else {
            // Ensure table exists
            await runAsync(`CREATE TABLE IF NOT EXISTS ${table} (lock_key TEXT PRIMARY KEY, token TEXT, expires_at INTEGER)`);
            const sql = `
                INSERT INTO ${table} (lock_key, token, expires_at) 
                VALUES (?, ?, ?) 
                ON CONFLICT (lock_key) DO UPDATE SET 
                    token = excluded.token,
                    expires_at = excluded.expires_at
                WHERE token = excluded.token OR expires_at < ?
            `;
            const rowCount = await runAsync(sql, [this.lockKey, this.ownerToken, expiresAt, now]);
            this.isAcquired = rowCount > 0;
        }

        return this.isAcquired;
    }

    private async releaseSql(): Promise<void> {
        await runAsync(`DELETE FROM ${TABLES.system_locks} WHERE lock_key = ? AND token = ?`, [
            this.lockKey,
            this.ownerToken
        ]);
    }
}
