/**
 * Redis/Valkey Client Management.
 * Provides a shared, lazily-initialized connection pool for the process.
 */
import Redis from "ioredis";

import { logger } from "../utils/logger";
import { env } from "./cfg";

let sharedClient: Redis | null = null;

/**
 * Gets or creates the shared Redis client instance.
 * Ensures only one connection pool is active per process.
 */
export const getRedisClient = (): Redis => {
    if (sharedClient) return sharedClient;

    logger.info("[REDIS] Initializing shared Redis connection...");
    sharedClient = new Redis({
        host: env.valkeyHost || "localhost",
        port: env.valkeyPort || 6379,
        password: env.valkeyPassword,
        lazyConnect: true, // Don't connect until used
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
    });

    sharedClient.on("error", (err) => {
        logger.error("[REDIS] Connection error:", { error: err });
    });

    sharedClient.on("connect", () => {
        logger.info("[REDIS] Connected successfully");
    });

    return sharedClient;
};

/**
 * Closes the shared Redis connection if it exists.
 */
export const closeRedis = async (): Promise<void> => {
    if (sharedClient) {
        logger.info("[REDIS] Closing shared connection...");
        await sharedClient.quit();
        sharedClient = null;
    }
};
