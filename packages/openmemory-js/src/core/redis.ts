/**
 * Redis/Valkey Client Management.
 * Provides a shared, lazily-initialized connection pool for the process.
 * 
 * @module core/redis
 */
import Redis from "ioredis";

import { logger } from "../utils/logger";
import { env } from "./cfg";

let sharedClient: Redis | null = null;
let reconnectAttempts = 0;

/**
 * Gets or creates the shared Redis client instance.
 * Ensures only one connection pool is active per process.
 */
export const getRedisClient = (): Redis => {
    if (sharedClient) return sharedClient;

    logger.info("[REDIS] Initializing shared Redis connection...", {
        host: env.valkeyHost || "localhost",
        port: env.valkeyPort || 6379,
    });

    sharedClient = new Redis({
        host: env.valkeyHost || "localhost",
        port: env.valkeyPort || 6379,
        password: env.valkeyPassword,
        lazyConnect: true, // Don't connect until first command
        connectTimeout: 10000, // 10s connection timeout
        maxRetriesPerRequest: 3, // Fail after 3 retries per command
        retryStrategy: (times) => {
            reconnectAttempts = times;
            if (times > 20) {
                logger.error("[REDIS] Max reconnection attempts reached, giving up");
                return null; // Stop retrying
            }
            const delay = Math.min(times * 100, 3000); // Up to 3s delay
            logger.warn(`[REDIS] Reconnecting (attempt ${times})...`, { delay });
            return delay;
        },
        enableReadyCheck: true,
    });

    sharedClient.on("error", (err) => {
        logger.error("[REDIS] Connection error:", { error: err.message });
    });

    sharedClient.on("connect", () => {
        logger.info("[REDIS] TCP connection established");
    });

    sharedClient.on("ready", () => {
        reconnectAttempts = 0;
        logger.info("[REDIS] Client ready, commands can be processed");
    });

    sharedClient.on("reconnecting", () => {
        logger.debug("[REDIS] Reconnecting to server...");
    });

    sharedClient.on("close", () => {
        logger.info("[REDIS] Connection closed");
    });

    return sharedClient;
};

/**
 * Checks if Redis is connected and ready.
 */
export const isRedisReady = (): boolean => {
    return sharedClient?.status === "ready";
};

/**
 * Returns the current reconnection attempt count.
 */
export const getReconnectAttempts = (): number => {
    return reconnectAttempts;
};

/**
 * Closes the shared Redis connection if it exists.
 * Uses graceful quit with fallback to disconnect.
 */
export const closeRedis = async (): Promise<void> => {
    if (sharedClient) {
        logger.info("[REDIS] Closing shared connection...");
        try {
            await sharedClient.quit();
        } catch (err) {
            // If quit fails (e.g., connection lost), force disconnect
            logger.warn("[REDIS] Graceful quit failed, forcing disconnect");
            sharedClient.disconnect();
        }
        sharedClient = null;
        reconnectAttempts = 0;
    }
};
