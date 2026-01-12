import { cache } from "../../core/cache";
import { env } from "../../core/cfg";
import { logger } from "../../utils/logger";
import { AppError, sendError } from "../errors";
import { AdvancedRequest, AdvancedResponse, NextFunction } from "../server";

/**
 * Rate Limiting Middleware.
 * Uses the unified CacheManager (Redis or Memory) to track request counts.
 * Prevents abuse by limiting requests per IP within a time window.
 */
export async function rateLimitMiddleware(
    req: AdvancedRequest,
    res: AdvancedResponse,
    next: NextFunction
) {
    if (!env.rateLimitEnabled) {
        return next();
    }

    // Smart Identification: User ID > IP
    // This allows authenticated users behind a shared proxy (e.g. corporate VPN) to have individual limits.
    let clientId = req.ip || "unknown";
    let keyPrefix = "rl:ip";

    if (req.user?.id) {
        clientId = req.user.id;
        keyPrefix = "rl:user";
    }

    const key = `${keyPrefix}:${clientId}`;

    // Configuration
    const windowMs = env.rateLimitWindowMs || 60000;
    const max = env.rateLimitMaxRequests || 100;
    const windowSecs = Math.ceil(windowMs / 1000);

    try {
        // Atomic increment
        const count = await cache.incr(key, windowSecs);

        // Calculate reset time (Approximate based on window)
        // Ideally we'd get TTL, but fixed window is sufficient for now.
        const resetTime = Date.now() + windowMs;

        res.setHeader("X-RateLimit-Limit", max.toString());
        res.setHeader("X-RateLimit-Remaining", Math.max(0, max - count).toString());
        res.setHeader("X-RateLimit-Reset", Math.ceil(resetTime / 1000).toString());

        if (count > max) {
            logger.warn(`[RateLimit] ${keyPrefix} ${clientId} exceeded limit (${max} reqs/${windowMs}ms)`);
            const retryAfter = windowSecs.toString();
            res.setHeader("Retry-After", retryAfter);

            return sendError(
                res,
                new AppError(
                    429,
                    "RATE_LIMIT_EXCEEDED",
                    "Too many requests. Please try again later.",
                    { retry_after: parseInt(retryAfter) }
                )
            );
        }

        next();
    } catch (e) {
        // Fail open: If redis/cache fails, allow request but log error
        logger.error("[RateLimit] Error checking limit:", { error: e });
        next();
    }
}
