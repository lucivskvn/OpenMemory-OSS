import { Elysia } from "elysia";
import { cache } from "../../core/cache";
import { env } from "../../core/cfg";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";

import { getUser } from "./auth";

interface RateLimitOptions {
    windowMs?: number;
    max?: number;
    keyPrefix?: string;
    message?: string;
}

export const rateLimitPlugin = (options: RateLimitOptions = {}) => (app: Elysia) => app.derive(async (ctx) => {
    if (!env.rateLimitEnabled) return {};

    const { request, set, server } = ctx;

    const windowMs = options.windowMs || env.rateLimitWindowMs || 60000;
    const max = options.max || env.rateLimitMaxRequests || 100;
    const prefix = options.keyPrefix || "rl";
    const msg = options.message || "Too many requests. Please try again later.";
    const windowSecs = Math.ceil(windowMs / 1000);

    // Try to get user from context (Auth plugin should run before this)
    const user = getUser(ctx);

    // Use User ID if authenticated, otherwise fallback to IP
    let clientId = "unknown";
    let type = "ip";

    if (user?.id) {
        clientId = user.id;
        type = "user";
    } else {
        // Elysia's `server.requestIP` is robust.
        clientId = server?.requestIP(request)?.address || "unknown";
    }

    let fullKeyPrefix = `${prefix}:${type}`;
    const key = `${fullKeyPrefix}:${clientId}`;

    try {
        const count = await cache.incr(key, windowSecs);
        const resetTime = Date.now() + windowMs;

        set.headers["X-RateLimit-Limit"] = max.toString();
        set.headers["X-RateLimit-Remaining"] = Math.max(0, max - count).toString();
        set.headers["X-RateLimit-Reset"] = Math.ceil(resetTime / 1000).toString();

        if (count > max) {
            logger.warn(`[RateLimit] ${fullKeyPrefix} ${clientId} exceeded limit (${max} reqs/${windowMs}ms)`);
            set.status = 429;
            set.headers["Retry-After"] = windowSecs.toString();
            throw new AppError(429, "RATE_LIMIT", msg);
        }
    } catch (e) {
        if (e instanceof AppError) throw e;
        if (e instanceof Error && e.message === msg) throw new AppError(429, "RATE_LIMIT", msg);

        // Fail-Closed in Prod
        if (env.isProd) {
            logger.error("[RateLimit] CRITICAL: Cache store unreachable.", { error: e });
            set.status = 503;
            set.status = 503;
            throw new AppError(503, "SERVICE_UNAVAILABLE", "Service Unavailable");
        }
        logger.warn("[RateLimit] Cache store unreachable (Fail-Open).");
    }

    return {};
});
