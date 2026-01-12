import { env } from "../../core/cfg";
import { insertFact } from "../../temporal_graph/store";
import { logger } from "../../utils/logger";
import { redact } from "../../utils/logger";
import { AdvancedRequest, AdvancedResponse, NextFunction } from "../server";

/**
 * Middleware to log mutating actions (write/audit) to the Temporal Graph.
 * "Eating our own dogfood" - using the system to audit itself.
 */
export async function auditMiddleware(
    req: AdvancedRequest,
    res: AdvancedResponse,
    next: NextFunction,
) {
    if (!env.logAuth) {
        // Skip if auditing is disabled (though usually we want this enabled for security)
        return await next();
    }

    // Only audit mutating methods
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        return await next();
    }

    const startTime = Date.now();

    // Proceed with request
    await next();

    // After request completion (or error if next throws, but usually errors are caught)
    // We only log successful actions (2xx) or explicit failures if relevant?
    // Let's log if statusCode < 400.
    if (res.statusCode >= 400) return;

    try {
        const userId = req.user?.id || "anonymous";
        const action = req.method;
        const resource = req.path; // e.g., /memory/123

        // Construct the fact
        // Subject: user:{userId}
        // Predicate: performed_POST
        // Object: {resource}

        const body = redact(req.body);
        const bodyStr = typeof body === "string" ? body : JSON.stringify(body);

        const meta: Record<string, unknown> = {
            ip: req.ip,
            params: redact(req.params),
            query: redact(req.query),
            body:
                bodyStr.length > 2000
                    ? bodyStr.slice(0, 2000) + " [TRUNCATED]"
                    : body,
            statusCode: res.statusCode,
            latency: Date.now() - startTime,
        };

        await insertFact(
            `user:${userId}`,
            `performed_${action}`,
            resource,
            new Date(startTime),
            1.0,
            meta,
            userId === "anonymous" ? null : userId,
        );
    } catch (e: unknown) {
        logger.error("[AUDIT] Failed to log audit fact:", { error: e });
        // Do not fail the request if audit fails, but log it.
    }
}
