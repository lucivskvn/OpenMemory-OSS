import { Elysia } from "elysia";
import * as crypto from "crypto";
import { env } from "../../core/cfg";
import { q } from "../../core/db";
import { normalizeUserId } from "../../utils";
import { logger, redact } from "../../utils/logger";
import { getUser } from "./auth";

/**
 * Audit Plugin
 * Logs mutating actions via `onResponse` (after handling).
 */
export const auditPlugin = new Elysia({ name: "audit" })
    .onAfterResponse(async (ctx) => {
        if (!env.logAuth) return;

        // Explicitly access context properties
        const { request, set, path, body, query, params } = ctx;

        // Only audit mutating methods
        // Elysia method is in request.method
        if (["GET", "HEAD", "OPTIONS", "TRACE"].includes(request.method)) {
            return;
        }

        // Check if `store` has user
        const user = getUser(ctx);
        const userId = user?.id ? normalizeUserId(user.id) : null;
        const action = request.method;
        const resource = path;

        // Resource Type mapping
        let resourceType = "unknown";
        let resourceId: string | null = null;

        if (resource.startsWith("/memory")) {
            resourceType = "memory";
            const parts = resource.split("/");
            if (parts.length > 2 && parts[2]?.length > 10) resourceId = parts[2];
        } else if (resource.startsWith("/admin/users")) {
            resourceType = "user";
            const parts = resource.split("/");
            if (parts.length > 3) resourceId = parts[3];
        }

        const secureBody = redact(body);
        const bodyStr = typeof secureBody === "string" ? secureBody : JSON.stringify(secureBody);

        const metadata: Record<string, unknown> = {
            params: redact(params),
            query: redact(query),
            body: bodyStr.length > 2000 ? bodyStr.slice(0, 2000) + " [TRUNCATED]" : secureBody,
            statusCode: set.status,
        };

        // Fire and forget
        q.auditLog.run({
            id: crypto.randomUUID(),
            userId: userId ?? null,
            action: `${action} ${resource}`,
            resourceType,
            resourceId,
            // Fallback to headers for IP since we don't have direct access to app.server in this context easily
            // and usually x-forwarded-for is what we want in production anyway.
            ipAddress: request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || null,
            userAgent: request.headers.get("user-agent") || null,
            metadata,
            timestamp: Date.now(),
        }).catch((err: any) => {
            logger.error("[AUDIT] Background log failed:", { error: err });
        });
    });
