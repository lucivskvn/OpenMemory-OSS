import { timingSafeEqual } from "node:crypto";

import { env } from "../../core/cfg";
import { runInContext, SecurityContext } from "../../core/context";
import { AuthScope, UserContext } from "../../core/types";
import { logger } from "../../utils/logger";
import { AppError, sendError } from "../errors";

const authConfig = {
    apiKeyHeader: "x-api-key",
    // Rate limits can stay static or be dynamic too, but keys must be dynamic for sure
    rateLimitEnabled: env.rateLimitEnabled,
    rateLimitWindowMs: env.rateLimitWindowMs,
    rateLimitMaxRequests: env.rateLimitMaxRequests,
    publicEndpoints: [
        "/health",
        "/api/system/health",
        "/api/system/stats",
        "/dashboard/health",
        "/setup/verify",
        "/setup/status",
        "/sources/webhook",
    ],
};

function isPublicEndpoint(path: string): boolean {
    return authConfig.publicEndpoints.some(
        (e) => path === e || path.startsWith(e),
    );
}

function extractApiKey(req: AdvancedRequest): string | null {
    // 1. Check configured API key header
    const headerKey = req.headers[authConfig.apiKeyHeader];
    const apiKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    if (apiKey) return apiKey;

    // 2. Check Authorization Header (Bearer/ApiKey scheme)
    const authHeader = req.headers["authorization"];
    const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (token) {
        if (token.startsWith("Bearer ")) return token.slice(7);
        if (token.startsWith("ApiKey ")) return token.slice(7);
    }

    // 3. Check Query Parameters (common for Streams/WebSockets)
    if (req.query) {
        // cast query to any or Record because Server update might allow it, but let's be safe
        const q = req.query as Record<string, string | string[] | undefined>;
        const queryToken = q.token || q.apiKey;
        if (queryToken && typeof queryToken === "string") return queryToken;
    }
    return null;
}

function validateApiKey(provided: string, expected?: string): boolean {
    if (!provided || !expected || provided.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}



/**
 * Derives a stable client ID.
 * Uses SHA-256 hash of the API key if provided, otherwise falls back to IP address.
 */
async function getClientId(req: { ip?: string }, apiKey: string | null): Promise<string> {
    if (apiKey) {
        const hash = await crypto.subtle.digest("SHA-256", Buffer.from(apiKey));
        return Buffer.from(hash).toString("hex").slice(0, 16);
    }
    return req.ip || "unknown";
}

import { AdvancedRequest, AdvancedResponse, NextFunction } from "../server";

/**
 * Middleware to authenticate requests via API keys.
 */
export const authenticateApiRequest = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
    next: NextFunction,
) => {
    try {
        const path = req.path || req.url || "";
        const isPublic = isPublicEndpoint(path);

        // Even for public/anonymous, we want a context for requestId traceability
        const getBaseCtx = (): SecurityContext => ({
            requestId: req.requestId,
        });

        if (isPublic) {
            return await runInContext(getBaseCtx(), () => next());
        }

        // Dynamic check of env config
        const currentApiKey = env.apiKey;
        const currentAdminKey = env.adminKey;

        // If no keys configured...
        if (
            (!currentApiKey || currentApiKey === "") &&
            (!currentAdminKey || currentAdminKey === "")
        ) {
            // CRITICAL: Prevent insecure default in production
            if (env.mode === "production" || env.isProd) {
                logger.error(
                    "[AUTH] 🚨 FATAL: No API keys configured in PRODUCTION mode. Request blocked.",
                );
                return sendError(
                    res,
                    new AppError(
                        500,
                        "CONFIGURATION_ERROR",
                        "Server is running in PRODUCTION mode but no API keys are configured. Please set OM_API_KEY or OM_ADMIN_KEY.",
                    ),
                );
            }

            // In Dev/Test mode, REQUIRE explicit opt-in for anonymous admin
            if (!env.noAuth) {
                logger.error(
                    "[AUTH] 🛑 Security Block: No API Keys set and OM_NO_AUTH is not enabled.",
                );
                return sendError(
                    res,
                    new AppError(
                        500,
                        "CONFIGURATION_ERROR",
                        "Security Block: No API keys are configured. To run in insecure mode (Anonymous Admin), you MUST set OM_NO_AUTH=true. Otherwise, set OM_API_KEY or OM_ADMIN_KEY.",
                    ),
                );
            }

            if (!req.user) {
                logger.warn(
                    "[AUTH] ⚠️  Running in Anonymous Admin Mode (OM_NO_AUTH=true). Logic is open.",
                );
            }

            // Assign default admin access if no auth configured (DEV MODE ONLY + OPT-IN)
            req.user = {
                id: "anonymous",
                scopes: ["admin:all"] as AuthScope[],
            };

            const ctx: SecurityContext = {
                ...getBaseCtx(),
                userId: req.user.id,
                scopes: req.user.scopes,
                isAdmin: true,
            };

            return await runInContext(ctx, () => next());
        }

        const provided = extractApiKey(req);
        if (!provided) {
            return sendError(
                res,
                new AppError(
                    401,
                    "AUTHENTICATION_REQUIRED",
                    "This server requires an API key for access. Please provide it in the 'x-api-key' header or as a Bearer token.",
                ),
            );
        }

        let scopes: AuthScope[] = [];
        let isValid = false;

        // Check Admin Key (Env)
        if (currentAdminKey && validateApiKey(provided, currentAdminKey)) {
            scopes = ["admin:all"];
            isValid = true;
        }
        // Check Standard API Key (Env)
        else if (currentApiKey && validateApiKey(provided, currentApiKey)) {
            scopes = ["memory:read", "memory:write"];
            isValid = true;
        } else {
            if (env.isTest) {
                logger.debug(`[AUTH_DEBUG] Key mismatch. Provided: ${provided.slice(0, 3)}... ExpectedAdmin: ${currentAdminKey ? currentAdminKey.slice(0, 3) + '...' : 'null'}, ExpectedUser: ${currentApiKey ? currentApiKey.slice(0, 3) + '...' : 'null'}`);
            }
            // Check DB for dynamic keys
            // We need to hash the provided key to lookup (since we store hashes)
            // But wait, the standard is usually to store the hash of the key.
            // My previous logic in `users.ts` registers `om_hex` and stores `hash(om_hex)`.
            // So we must hash `provided` here.

            const hashBuffer = await crypto.subtle.digest(
                "SHA-256",
                Buffer.from(provided),
            );
            const hash = Buffer.from(hashBuffer).toString("hex");

            // Import `q` dynamically to avoid circular issues if any (but auth -> db is usually fine)
            const { q } = await import("../../core/db");
            const dbKey = await q.getApiKey.get(hash);

            if (dbKey) {
                isValid = true;
                // Identify the user explicitly from the DB record
                // This SUPPORTS MULTI-TENANCY: The request is now tied to dbKey.userId
                req.user = {
                    id: dbKey.userId,
                    scopes:
                        dbKey.role === "admin"
                            ? ["admin:all"]
                            : ["memory:read", "memory:write"],
                };

                // Add note to logger?
                // logger.debug(`[AUTH] Authenticated as ${dbKey.userId} (${dbKey.role})`);
            }
        }

        if (!isValid) {
            return sendError(
                res,
                new AppError(
                    403,
                    "INVALID_API_KEY",
                    "The provided API key is incorrect.",
                ),
            );
        }

        // If we found the user in the DB, use that ID. Otherwise fallback to legacy hash (for Env keys)
        let clientId = req.user?.id;
        if (!clientId) {
            clientId = await getClientId(req, provided);
            const userCtx: UserContext = { id: clientId, scopes };
            req.user = userCtx;
        }



        const ctx: SecurityContext = {
            userId: req.user?.id,
            scopes: req.user?.scopes,
            isAdmin: (req.user?.scopes || []).includes("admin:all"),
            requestId: req.requestId,
        };

        return await runInContext(ctx, () => next());
    } catch (e) {
        next(e);
    }
};

/**
 * Middleware to log authenticated requests for audit trails.
 */
export async function logAuthenticatedRequest(
    req: AdvancedRequest,
    _res: AdvancedResponse,
    next: NextFunction,
) {
    try {
        const key = extractApiKey(req);
        if (key) {
            const hash = await crypto.subtle.digest(
                "SHA-256",
                Buffer.from(key),
            );
            const hex = Buffer.from(hash).toString("hex").slice(0, 8);
            logger.info(`[AUTH] ${req.method} ${req.path} `, { keyHash: hex });
        }
        await next();
    } catch (e) {
        logger.error("[AUTH] Logging failed:", { error: e });
        next();
    }
}

/**
 * Standardized RBAC check: Verifies if the requester is the target user or an admin.
 * Throws 403 if access is denied.
 */
export function verifyUserAccess(req: AdvancedRequest, targetUserId: string | null | undefined): void {
    const authUserId = req.user?.id; // IDs are normalized in middleware usually, but be safe?
    // Middleware extractApiKey -> q.getApiKey -> returns ID from DB (normalized there?)
    // Basic normalization:
    const nAuth = authUserId ? authUserId.trim() : null;
    const nTarget = targetUserId ? targetUserId.trim() : null;

    const isAdmin = (req.user?.scopes || []).includes("admin:all");

    if (nAuth && nAuth !== nTarget && !isAdmin) {
        throw new AppError(403, "FORBIDDEN", "Access denied");
    }
}

/**
 * Middleware: Requires 'admin:all' scope.
 */
export const requireAdmin = (req: AdvancedRequest, res: AdvancedResponse, next: NextFunction) => {
    const isAdmin = (req.user?.scopes || []).includes("admin:all");
    if (!isAdmin) {
        return sendError(res, new AppError(403, "FORBIDDEN", "Admin access required"));
    }
    next();
};

// Removed interval cleanup as cache now handles TTL expiration natively
