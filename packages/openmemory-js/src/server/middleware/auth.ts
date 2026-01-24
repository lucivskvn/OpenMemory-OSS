import { Elysia } from "elysia";
import { env } from "../../core/cfg";
import { AuthScope, UserContext } from "../../core/types";
export type { UserContext };
import { logger } from "../../utils/logger";
import { AppError } from "../errors";
import { normalizeUserId } from "../../utils";
import { createAuthError, createAuthorizationError, createConfigError } from "../../utils/errors";

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    return globalThis.crypto.timingSafeEqual(a, b);
}

const authConfig = {
    apiKeyHeader: "x-api-key",
    publicEndpoints: [
        "/health",
        "/api/system/health",
        "/api/system/stats",
        "/dashboard/health",
        "/setup/verify",
        "/setup/status",
        "/sources/webhook",
        "/public",
    ],
};

function isPublicEndpoint(path: string): boolean {
    return authConfig.publicEndpoints.some(
        (e) => path === e || path.startsWith(e),
    );
}

// Helper to extract key from request
function extractApiKey(req: Request | any): string | null {
    const headers = req.headers;
    
    // Handle both Request objects (with headers.get) and plain objects (for tests)
    const getHeader = (name: string): string | null => {
        if (headers && typeof headers.get === 'function') {
            return headers.get(name);
        } else if (headers && typeof headers === 'object') {
            return headers[name] || null;
        }
        return null;
    };
    
    const headerKey = getHeader(authConfig.apiKeyHeader);
    if (headerKey) return headerKey;

    const authHeader = getHeader("authorization");
    if (authHeader) {
        if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);
        if (authHeader.startsWith("ApiKey ")) return authHeader.slice(7);
    }

    // Handle URL parsing safely
    try {
        const url = new URL(req.url || req.path || "http://localhost/");
        const queryToken = url.searchParams.get("token") || url.searchParams.get("apiKey");
        if (queryToken) return queryToken;
    } catch {
        // Ignore URL parsing errors for test objects
    }

    return null;
}

async function validateApiKey(provided: string, expected?: string): Promise<boolean> {
    if (!provided || !expected) return false;
    try {
        const enc = new TextEncoder();
        const h1 = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(provided));
        const h2 = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(expected));
        return timingSafeEqual(new Uint8Array(h1), new Uint8Array(h2));
    } catch {
        return false;
    }
}

async function getClientId(ip: string | null, apiKey: string | null): Promise<string> {
    const enc = new TextEncoder();
    if (apiKey) {
        const hash = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(apiKey));
        return Buffer.from(hash).toString("hex");
    }
    if (ip) {
        const hash = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(`ip:${ip}`));
        return `ip_${Buffer.from(hash).toString("hex").slice(0, 32)}`;
    }
    const randomBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return `anon_${Buffer.from(randomBytes).toString("hex")}`;
}

/**
 * Elysia Auth Plugin
 * Derives `user` context for each request.
 */
// Helper to get user from context or store (for refactoring transition)
export const getUser = (ctx: any): UserContext | undefined => {
    return ctx.user || ctx.store?.user;
};

export const authPlugin = (app: Elysia) => app.derive(async (ctx) => {
    const { request, set, path, store } = ctx;

    // Public bypass
    if (isPublicEndpoint(path)) {
        return { user: undefined };
    }

    const currentApiKey = env.apiKey || "";
    const currentAdminKey = env.adminKey || "";
    const provided = extractApiKey(request);

    // Security Block if no keys
    if (currentApiKey === "" && currentAdminKey === "") {
        if (!provided && Bun.env.OM_NO_AUTH !== "true" && !env.noAuth) {
            if (env.isProd) {
                logger.error("[AUTH] 🚨 FATAL: No API keys configured in PRODUCTION mode. Request blocked.");
                set.status = 500;
                throw createConfigError("Authentication Configuration Error");
            }
            logger.error("[AUTH] 🛑 Security Block: No API Keys set.");
            set.status = 500;
            throw createConfigError("Authentication Configuration Error");
        }

        // Anonymous Admin Mode
        if (!provided && (Bun.env.OM_NO_AUTH === "true" || env.noAuth)) {
            const user = {
                id: "anonymous",
                scopes: ["admin:all"] as AuthScope[],
            };
            return { user };
        }
    }

    if (!provided) {
        set.status = 401;
        throw createAuthError("Authentication required");
    }

    let scopes: AuthScope[] = [];
    let isValid = false;
    let dbUserId: string | undefined;

    // 1. Check Admin Key
    if (currentAdminKey && await validateApiKey(provided, currentAdminKey)) {
        scopes = ["admin:all"];
        isValid = true;
    }
    // 2. Check Standard Key
    else if (currentApiKey && await validateApiKey(provided, currentApiKey)) {
        scopes = ["memory:read", "memory:write"];
        isValid = true;
    }
    // 3. Check DB
    else {
        const enc = new TextEncoder();
        const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(provided));
        const hash = Buffer.from(hashBuffer).toString("hex");

        // Lazy load DB query
        const { q } = await import("../../core/db");
        const dbKey = await q.getApiKey.get(hash);

        if (dbKey) {
            isValid = true;
            dbUserId = dbKey.userId;
            scopes = dbKey.role === "admin"
                ? ["admin:all"]
                : dbKey.role === "read_only"
                    ? ["memory:read"]
                    : ["memory:read", "memory:write"];
        }
    }

    if (!isValid) {
        set.status = 403;
        throw createAuthorizationError("Invalid API Key");
    }

    // Final User ID Resolution
    let clientId = dbUserId;
    if (!clientId) {
        clientId = await getClientId(null, provided);
    }

    const user: UserContext = {
        id: clientId,
        scopes
    };

    // Log Auth if enabled
    if (env.logAuth) {
        const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided));
        const hex = Buffer.from(hash).toString("hex").slice(0, 8);
        logger.info(`[AUTH] Authenticated ${user.id} scopes=[${scopes.join(',')}] key=${hex}`);
    }

    // Compatibility: Also set in store for plugins accessing store.user
    if (store) {
        (store as any).user = user;
    }

    return { user };
});


/**
 * Legacy middleware function for Express-style authentication
 * @deprecated Use authPlugin instead for Elysia applications
 */
export async function authenticateApiRequest(req: any, res: any, next: () => void): Promise<void> {
    try {
        // Extract API key from request
        const provided = extractApiKey(req);
        
        // Check if endpoint is public
        const path = req.url || req.path || "";
        if (isPublicEndpoint(path)) {
            return next();
        }

        const currentApiKey = env.apiKey || "";
        const currentAdminKey = env.adminKey || "";

        // Security Block if no keys
        if (currentApiKey === "" && currentAdminKey === "") {
            if (!provided && Bun.env.OM_NO_AUTH !== "true" && !env.noAuth) {
                if (env.isProd) {
                    logger.error("[AUTH] 🚨 FATAL: No API keys configured in PRODUCTION mode. Request blocked.");
                    res.status = 500;
                    throw new Error("Authentication Configuration Error");
                }
                logger.error("[AUTH] 🛑 Security Block: No API Keys set.");
                res.status = 500;
                throw new Error("Authentication Configuration Error");
            }

            // Anonymous Admin Mode
            if (!provided && (Bun.env.OM_NO_AUTH === "true" || env.noAuth)) {
                req.user = {
                    id: "anonymous",
                    scopes: ["admin:all"] as AuthScope[],
                };
                return next();
            }
        }

        if (!provided) {
            res.status = 401;
            throw new Error("Authentication required");
        }

        let scopes: AuthScope[] = [];
        let isValid = false;
        let dbUserId: string | undefined;

        // 1. Check Admin Key
        if (currentAdminKey && await validateApiKey(provided, currentAdminKey)) {
            scopes = ["admin:all"];
            isValid = true;
        }
        // 2. Check Standard Key
        else if (currentApiKey && await validateApiKey(provided, currentApiKey)) {
            scopes = ["memory:read", "memory:write"];
            isValid = true;
        }
        // 3. Check DB
        else {
            const enc = new TextEncoder();
            const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(provided));
            const hash = Buffer.from(hashBuffer).toString("hex");

            // Lazy load DB query
            const { q } = await import("../../core/db");
            const dbKey = await q.getApiKey.get(hash);

            if (dbKey) {
                isValid = true;
                dbUserId = dbKey.userId;
                scopes = dbKey.role === "admin"
                    ? ["admin:all"]
                    : dbKey.role === "read_only"
                        ? ["memory:read"]
                        : ["memory:read", "memory:write"];
            }
        }

        if (!isValid) {
            res.status = 403;
            throw new Error("Invalid API Key");
        }

        // Final User ID Resolution
        let clientId = dbUserId;
        if (!clientId) {
            clientId = await getClientId(null, provided);
        }

        req.user = {
            id: clientId,
            scopes
        };

        // Log Auth if enabled
        if (env.logAuth) {
            const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided));
            const hex = Buffer.from(hash).toString("hex").slice(0, 8);
            logger.info(`[AUTH] Authenticated ${req.user.id} scopes=[${scopes.join(',')}] key=${hex}`);
        }

        next();
    } catch (error) {
        logger.error("[AUTH] Authentication failed", { error });
        if (!res.status) res.status = 500;
        throw error;
    }
}

/**
 * Legacy RBAC Helper for manual checks inside handlers
 * Fixed to handle null returns properly and provide consistent behavior
 */
export function verifyUserAccess(user: UserContext | undefined, targetUserId: string | null | undefined): string | null {
    const authUserId = user?.id;
    const nAuth = authUserId ? authUserId.trim() : null;
    let nTarget = targetUserId ? targetUserId.trim() : null;

    // Handle "me" alias - resolve to authenticated user ID
    if (nTarget === "me" && nAuth) {
        nTarget = nAuth;
    }

    const isAdmin = (user?.scopes || []).includes("admin:all");

    if (!isAdmin) {
        if (!nAuth) {
            // No authentication - only allow if no target is specified (global access)
            if (nTarget) {
                throw new AppError(401, "UNAUTHORIZED", "Authentication required for user access");
            }
            return null; // No auth, no target - return null for global access
        } else {
            // For non-admin users, they can only access their own data
            if (nTarget && nAuth !== nTarget) {
                throw new AppError(403, "FORBIDDEN", "Access denied: users can only access their own data");
            }
            // If no target specified, default to authenticated user
            return nTarget || nAuth;
        }
    }
    
    // Admin can access any user or return the target as-is
    // If admin specifies no target, return null for global access
    return nTarget;
}

/**
 * Helper to resolve the effective target user ID based on auth context and request/query param.
 * - If Admin: Can impersonate any user (if clientUserId provided) or target self.
 * - If User: Can only target self (clientUserId must match or be null/undefined).
 * - Enforces correct null/undefined handling for global vs user-scoped resources.
 */
export const getEffectiveUserId = (user: UserContext | undefined, clientUserId: string | null | undefined): string | null => {
    // 0. Pre-normalize
    const normalizedClient = clientUserId ? normalizeUserId(clientUserId) : null;
    const normalizedAuth = user?.id ? normalizeUserId(user.id) : null;
    const isAdmin = (user?.scopes || []).includes("admin:all");

    // 1. Admin Override Logic
    if (isAdmin) {
        // If admin provides a specific user ID, use it.
        // If admin provides explicit "null" or nothing, they might intend global context (depending on caller).
        // But usually, if clientUserId is provided, we respect it.
        if (normalizedClient) return normalizedClient;

        // If no clientUserId, we default to the admin's own ID? 
        // OR do we return null (global)? 
        // Context: In `memory.ts`, if query.userId is undefined, we default to auth's ID usually.
        // Let's mirror the robust logic from memory.ts:
        // "const targetUserId = (isAdmin && normalizedClient !== undefined) ? normalizedClient : normalizedUser;"
        // Wait, normalizedClient is null if undefined/empty.
        if (clientUserId !== undefined && clientUserId !== null) return normalizedClient ?? null;

        // If clientUserId was NOT provided, fallback to Admin's own ID.
        return normalizedAuth ?? null;
    }

    // 2. Regular User Logic
    // Must target self.
    // verifyUserAccess handles the check "if client says user X, but I am Y -> Error"
    // It also handles "if client says nothing, defaults to me".
    // But verifyUserAccess returns the ID.

    // We pass 'clientUserId' as the target. If it's null/undefined, verifyUserAccess usually requires auth.
    return verifyUserAccess(user, normalizedClient) ?? null;
};
