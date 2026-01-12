import { webcrypto } from "node:crypto";
import { env } from "../core/cfg";
import { getAsync, runAsync } from "../core/db";
import { getRedisClient } from "../core/redis";
import { logger } from "./logger";

/**
 * Interface for distributed locking.
 */
export interface Lock {
    acquire(ttlMs?: number): Promise<boolean>;
    release(): Promise<void>;
}

/**
 * DistributedLock utility supporting multiple backends.
 * Uses a token-based approach to ensure only the owner can release the lock.
 */
export class DistributedLock implements Lock {
    private backend: "redis" | "postgres" | "sqlite";
    private lockKey: string;
    private ownerToken: string;
    private isAcquired: boolean = false;

    constructor(name: string) {
        this.lockKey = `lock:${name}`;
        this.ownerToken = webcrypto.randomUUID();

        // Determine backend based on configuration
        if (env.lockBackend !== "auto") {
            this.backend = env.lockBackend as "redis" | "postgres" | "sqlite";
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
        if (this.isAcquired) return true;

        try {
            switch (this.backend) {
                case "redis":
                    return await this.acquireRedis(ttlMs);
                case "postgres":
                    return await this.acquirePostgres(ttlMs);
                case "sqlite":
                    return await this.acquireSqlite(ttlMs);
            }
        } catch (e) {
            logger.error(`[LOCK] Failed to acquire lock ${this.lockKey}:`, {
                error: e,
            });
            return false;
        }
    }

    /**
     * Releases the acquired lock.
     */
    async release(): Promise<void> {
        if (!this.isAcquired) return;

        try {
            switch (this.backend) {
                case "redis":
                    await this.releaseRedis();
                    break;
                case "postgres":
                    await this.releasePostgres();
                    break;
                case "sqlite":
                    await this.releaseSqlite();
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
        // Set NX (Not Exists) PX (P-Expire)
        const res = await client.set(this.lockKey, this.ownerToken, "PX", ttlMs, "NX");
        this.isAcquired = res === "OK";
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

    private async acquirePostgres(ttlMs: number): Promise<boolean> {
        // Use a table-based lock for robust connection-pool safety
        // Ensure table exists (best effort, ideally done in migration)
        await runAsync(
            `CREATE TABLE IF NOT EXISTS system_locks (lock_key TEXT PRIMARY KEY, token TEXT, expires_at BIGINT)`,
        );

        const now = Date.now();

        // 1. Clean up expired locks first (Lazy expiration)
        await runAsync(
            `DELETE FROM system_locks WHERE lock_key = ? AND expires_at < ?`,
            [this.lockKey, now]
        );

        // 2. Try to insert lock
        try {
            await runAsync(
                `INSERT INTO system_locks (lock_key, token, expires_at) VALUES (?, ?, ?)`,
                [this.lockKey, this.ownerToken, now + ttlMs]
            );
            this.isAcquired = true;
            return true;
        } catch {
            // Insert failed (Primary Key conflict or other)
            // Check if we already own it (Re-entrancy support)
            const row = await getAsync<{ token: string }>(
                `SELECT token FROM system_locks WHERE lock_key = ?`,
                [this.lockKey]
            );

            if (row && row.token === this.ownerToken) {
                // Extend lease
                await runAsync(
                    `UPDATE system_locks SET expires_at = ? WHERE lock_key = ? AND token = ?`,
                    [now + ttlMs, this.lockKey, this.ownerToken]
                );
                this.isAcquired = true;
                return true;
            }

            return false;
        }
    }

    private async releasePostgres(): Promise<void> {
        await runAsync(
            `DELETE FROM system_locks WHERE lock_key = ? AND token = ?`,
            [this.lockKey, this.ownerToken]
        );
    }

    private async acquireSqlite(ttlMs: number): Promise<boolean> {
        // Ensure system_locks table exists
        await runAsync(
            `CREATE TABLE IF NOT EXISTS system_locks (lock_key TEXT PRIMARY KEY, token TEXT, expires_at INTEGER)`,
        );

        const now = Date.now();
        // Clean up expired locks
        await runAsync(`DELETE FROM system_locks WHERE expires_at < ?`, [now]);

        try {
            await runAsync(
                `INSERT INTO system_locks (lock_key, token, expires_at) VALUES (?, ?, ?)`,
                [this.lockKey, this.ownerToken, now + ttlMs],
            );
            this.isAcquired = true;
            return true;
        } catch {
            // Check re-entrancy
            const row = await getAsync<{ token: string }>(
                `SELECT token FROM system_locks WHERE lock_key = ?`,
                [this.lockKey]
            );
            if (row && row.token === this.ownerToken) {
                await runAsync(
                    `UPDATE system_locks SET expires_at = ? WHERE lock_key = ? AND token = ?`,
                    [now + ttlMs, this.lockKey, this.ownerToken]
                );
                this.isAcquired = true;
                return true;
            }
            return false;
        }
    }

    private async releaseSqlite(): Promise<void> {
        await runAsync(`DELETE FROM system_locks WHERE lock_key = ? AND token = ?`, [
            this.lockKey,
            this.ownerToken
        ]);
    }
}
