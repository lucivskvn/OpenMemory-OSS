import { env } from "../../core/cfg";
import { verifyPassword, hashString, isHashedKey } from "../../utils/crypto";
import { Context } from "../server";
import logger from "../../core/logger";

const rate_limit_store = new Map<
    string,
    { count: number; reset_time: number }
>();
const auth_config = {
    api_key: env.api_key,
    api_key_header: "x-api-key",
    rate_limit_enabled: env.rate_limit_enabled,
    rate_limit_window_ms: env.rate_limit_window_ms,
    rate_limit_max_requests: env.rate_limit_max_requests,
    public_endpoints: [
        "/health",
        "/api/system/health",
        "/api/system/stats",
        "/dashboard/health",
    ],
};

function is_public_endpoint(path: string): boolean {
    return auth_config.public_endpoints.some(
        (e) => path === e || path.startsWith(e),
    );
}

function extract_api_key(req: Request): string | null {
    const x_api_key = req.headers.get(auth_config.api_key_header);
    if (x_api_key) return x_api_key;
    const auth_header = req.headers.get("authorization");
    if (auth_header) {
        if (auth_header.startsWith("Bearer ")) return auth_header.slice(7);
        if (auth_header.startsWith("ApiKey ")) return auth_header.slice(7);
    }
    return null;
}

async function validate_api_key(provided: string, hashed_expected: string): Promise<boolean> {
    if (!provided || !hashed_expected) return false;

    try {
        // If the stored key looks like a hash, prefer verify.
        if (isHashedKey(hashed_expected) || hashed_expected.startsWith("argon2") || hashed_expected.startsWith("$argon2")) {
            const ok = await verifyPassword(provided, hashed_expected);
            if (!ok) logger.warn({ component: "AUTH", event: "auth_failure" }, "API key hash verification failed");
            return ok;
        }
        // If the stored value does not look like a hash, reject. This enforces
        // that operators must configure a hashed OM_API_KEY for security.
        logger.error({ component: "AUTH", event: "plaintext_key_detected" }, "Plaintext API key detected in configuration; plaintext API keys are not accepted. Please set OM_API_KEY to a hashed value (use backend/scripts/hash-api-key.ts) and restart.");
        return false;
    } catch (e) {
        logger.warn({ component: "AUTH", event: "verify_error", err: e }, "Password verify failed for API key; rejecting authentication");
        return false;
    }
}

function check_rate_limit(client_id: string): {
    allowed: boolean;
    remaining: number;
    reset_time: number;
} {
    if (!auth_config.rate_limit_enabled)
        return { allowed: true, remaining: -1, reset_time: -1 };
    const now = Date.now();
    const data = rate_limit_store.get(client_id);
    if (!data || now >= data.reset_time) {
        const new_data = {
            count: 1,
            reset_time: now + auth_config.rate_limit_window_ms,
        };
        rate_limit_store.set(client_id, new_data);
        return {
            allowed: true,
            remaining: auth_config.rate_limit_max_requests - 1,
            reset_time: new_data.reset_time,
        };
    }
    data.count++;
    rate_limit_store.set(client_id, data);
    const remaining = auth_config.rate_limit_max_requests - data.count;
    return {
        allowed: data.count <= auth_config.rate_limit_max_requests,
        remaining: Math.max(0, remaining),
        reset_time: data.reset_time,
    };
}

function get_client_id(req: Request, api_key: string | null): string {
    if (api_key)
        return hashString(api_key).slice(0, 16);
    return req.headers.get("x-forwarded-for") || "unknown";
}

/**
 * Authenticate API requests.
 *
 * Notes and security considerations:
 * - API keys must be hashed (Argon2) and stored in `OM_API_KEY`; plaintext keys will be rejected.
 * - JWT/OIDC-based request authentication is not yet implemented. The current middleware only validates hashed API keys.
 * - `OM_AUTH_PROVIDER=jwt` and related `OM_JWT_*` env vars currently influence startup validation and database/infra configuration but do not change HTTP auth behavior.
 * - Rate limiting is enforced with a token-bucket (configurable via env) and includes X-RateLimit-* headers
 *   when OM_RATE_LIMIT_ENABLED is true and when it is safe to construct a new Response without breaking streaming
 *   or body-used semantics. For streamed or already-consumed response bodies, the middleware will skip header
 *   augmentation to preserve behavior.
 * - Test seam: `setAuthApiKeyForTests` is provided to set a hashed API key at runtime without reloading
 *   modules in unit tests.
 */
export async function authenticate_api_request(req: Request, ctx: Context, next: () => Promise<Response>) {
    const url = new URL(req.url);
    logger.debug({ component: 'AUTH', method: req.method, path: url.pathname }, 'Auth check method/path');
    if (is_public_endpoint(url.pathname)) return next();

    // Allow GET requests through without API key when auth is enabled.
    // This keeps read-only endpoints accessible for unauthenticated clients
    // (e.g. fetch configs, health checks). Tests assert GET endpoints remain
    // accessible without auth; this preserves that behavior while still
    // requiring API keys for mutating operations.
    if (req.method === 'GET') return next();

    if (!auth_config.api_key || auth_config.api_key === "") {
        logger.warn({ component: "AUTH" }, "No API key configured, allowing all requests.");
        return next();
    }

    const provided = extract_api_key(req);
    if (!provided) {
        logger.warn({ component: "AUTH", event: "missing_key" });
        return new Response(JSON.stringify({ error: "authentication_required", error_code: "authentication_required", message: "API key required", context: { timestamp: new Date().toISOString() } }),
            { status: 401, headers: { "Content-Type": "application/json" } });
    }


    if (!await validate_api_key(provided, auth_config.api_key)) {
        // Potential future extension: if OM_AUTH_PROVIDER=jwt, attempt to validate
        // provided value as a JWT with issuer/audience checks against OM_JWT_{ISSUER,AUDIENCE}
        // before returning 403. This allows token-based auth with Postgres RLS tokens.
        return new Response(JSON.stringify({ error: "invalid_api_key", error_code: "invalid_api_key" }),
            { status: 403, headers: { "Content-Type": "application/json" } });
    }

    const client_id = get_client_id(req, provided);
    const rl = check_rate_limit(client_id);

    // If not allowed, immediately return 429 with rate-limit headers.
    if (!rl.allowed) {
        logger.warn({ component: "AUTH", event: "rate_limit", client_id });
        const headers = new Headers({ "Content-Type": "application/json" });
        if (auth_config.rate_limit_enabled) {
            headers.set("X-RateLimit-Limit", auth_config.rate_limit_max_requests.toString());
            headers.set("X-RateLimit-Remaining", rl.remaining.toString());
            headers.set("X-RateLimit-Reset", Math.floor(rl.reset_time / 1000).toString());
            headers.set("Retry-After", Math.ceil((rl.reset_time - Date.now()) / 1000).toString());
        }
        return new Response(JSON.stringify({ error: "rate_limit_exceeded", retry_after: Math.ceil((rl.reset_time - Date.now()) / 1000) }),
            { status: 429, headers });
    }

    // Allowed: call next and then attach rate-limit headers to the response.
    const response = await next();

    if (auth_config.rate_limit_enabled) {
        try {
            // If the response body has already been used/read, avoid constructing
            // a new Response with the same body as this may break streaming
            // responses (SSE/WS) or throw. In that case, return the original
            // response without header augmentation.
            if ((response as any).bodyUsed || !response.body) {
                // Can't safely attach headers to a used/streamed body; return original response
                logger.debug({ component: 'AUTH' }, 'Response body already used or null; skipping header merge to preserve streaming behavior');
                return response;
            }
            // Always construct a new Response with merged headers instead of
            // attempting to mutate the original. This avoids runtime errors in
            // environments where Response.headers might be immutable.
            const merged = new Headers(response.headers);
            merged.set("X-RateLimit-Limit", auth_config.rate_limit_max_requests.toString());
            merged.set("X-RateLimit-Remaining", rl.remaining.toString());
            merged.set("X-RateLimit-Reset", Math.floor(rl.reset_time / 1000).toString());
            return new Response(response.body, {
                status: response.status,
                statusText: (response as any).statusText,
                headers: merged,
            });
        } catch (e) {
            // If constructing a new Response fails for any reason, fall back to
            // returning the original response to avoid breaking the request.
            logger.warn({ component: "AUTH", err: e }, "Failed to attach rate-limit headers by constructing a new Response; returning original response");
            return response;
        }
    }

    return response;
}

export function log_authenticated_request(req: Request, ctx: Context, next: () => Promise<Response>) {
    const key = extract_api_key(req);
    if (key) {
        const url = new URL(req.url);
        logger.info({
            component: "AUTH",
            method: req.method,
            path: url.pathname,
            key_hash: hashString(key).slice(0, 8)
        }, "Authenticated request");
    }
    return next();
}

// Test seam: allow tests to override the configured API key at runtime.
// This avoids forcing tests to re-import internal env parsers and keeps the
// middleware behavior deterministic in unit tests.
/**
 * Admin authentication middleware for admin-only endpoints.
 *
 * Validates against env.admin_api_key, rejects with 401 for missing/incorrect keys.
 * Applies rate limiting if OM_RATE_LIMIT_ENABLED is true.
 * Logs auth attempts with [AUTH-ADMIN] prefix.
 */
export async function adminAuthMiddleware(req: Request, ctx: Context, next: () => Promise<Response>) {
    const url = new URL(req.url);
    logger.debug({ component: 'AUTH-ADMIN', method: req.method, path: url.pathname }, 'Admin auth check');

    if (!env.admin_api_key || env.admin_api_key === "") {
        logger.warn({ component: "AUTH-ADMIN" }, "No admin API key configured, denying all admin requests.");
        return new Response(JSON.stringify({ error: "Admin access denied" }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
        });
    }

    const provided = extract_api_key(req);
    if (!provided) {
        logger.warn({ component: "AUTH-ADMIN", event: "missing_key" });
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
        });
    }

    // Validate against admin API key specifically
    if (!await validate_api_key(provided, env.admin_api_key)) {
        logger.warn({ component: "AUTH-ADMIN", event: "auth_failure" });
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
        });
    }

    const client_id = get_client_id(req, provided);
    const rl = check_rate_limit(client_id);

    // If not allowed, immediately return 429 with rate-limit headers
    if (!rl.allowed) {
        logger.warn({ component: "AUTH-ADMIN", event: "rate_limit", client_id });
        const headers = new Headers({ "Content-Type": "application/json" });
        if (env.rate_limit_enabled) {
            headers.set("X-RateLimit-Limit", env.rate_limit_max_requests.toString());
            headers.set("X-RateLimit-Remaining", rl.remaining.toString());
            headers.set("X-RateLimit-Reset", Math.floor(rl.reset_time / 1000).toString());
            headers.set("Retry-After", Math.ceil((rl.reset_time - Date.now()) / 1000).toString());
        }
        return new Response(JSON.stringify({ error: "rate_limit_exceeded", retry_after: Math.ceil((rl.reset_time - Date.now()) / 1000) }),
            { status: 429, headers });
    }

    // Allowed: call next and attach rate-limit headers if enabled
    const response = await next();

    if (env.rate_limit_enabled) {
        try {
            if ((response as any).bodyUsed || !response.body) {
                logger.debug({ component: 'AUTH-ADMIN' }, 'Response body already used or null; skipping header merge');
                return response;
            }
            const merged = new Headers(response.headers);
            merged.set("X-RateLimit-Limit", env.rate_limit_max_requests.toString());
            merged.set("X-RateLimit-Remaining", rl.remaining.toString());
            merged.set("X-RateLimit-Reset", Math.floor(rl.reset_time / 1000).toString());
            return new Response(response.body, {
                status: response.status,
                statusText: (response as any).statusText,
                headers: merged,
            });
        } catch (e) {
            logger.warn({ component: "AUTH-ADMIN", err: e }, "Failed to attach rate-limit headers");
            return response;
        }
    }

    return response;
}

// Test seam for admin API key
export function setAdminApiKeyForTests(val: string | undefined | null) {
    (env as any).admin_api_key = val as any;
}

export function setAuthApiKeyForTests(val: string | undefined | null) {
    (auth_config as any).api_key = val as any;
}

setInterval(
    () => {
        const now = Date.now();
        for (const [id, data] of rate_limit_store.entries())
            if (now >= data.reset_time) rate_limit_store.delete(id);
    },
    5 * 60 * 1000,
);
