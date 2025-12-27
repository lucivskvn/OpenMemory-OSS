import { authConfig } from "../../core/cfg";
import crypto from "crypto";
import { Elysia } from "elysia";
import { log } from "../../core/log";

const rate_limit_store = new Map<
    string,
    { count: number; reset_time: number }
>();

// Testing helper to reset rate limit store
export function _resetRateLimitStore() {
    rate_limit_store.clear();
}
const MAX_RATE_LIMIT_KEYS = 10000;

function is_public_endpoint(path: string): boolean {
    return authConfig.public_endpoints.some(
        (e) => path === e || path.startsWith(e),
    );
}

function extract_api_key(headers: any): string | null {
    // Support both plain object maps and Fetch Headers-like objects
    const getHeader = (k: string) => {
        if (!headers) return undefined;
        if (typeof headers.get === "function") return headers.get(k);
        return headers[k] || headers[k.toLowerCase()];
    };
    const x_api_key = getHeader(authConfig.api_key_header);
    if (x_api_key) return x_api_key as string;
    const auth_header = getHeader("authorization");
    if (auth_header) {
        if ((auth_header as string).startsWith("Bearer ")) return (auth_header as string).slice(7);
        if ((auth_header as string).startsWith("ApiKey ")) return (auth_header as string).slice(7);
    }
    return null;
}

function validate_api_key(provided: string, expected: string): boolean {
    if (!provided || !expected || provided.length !== expected.length)
        return false;
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function check_rate_limit(client_id: string): {
    allowed: boolean;
    remaining: number;
    reset_time: number;
} {
    if (!authConfig.rate_limit_enabled)
        return { allowed: true, remaining: -1, reset_time: -1 };
    const now = Date.now();
    const data = rate_limit_store.get(client_id);
    if (!data || now >= data.reset_time) {
        if (rate_limit_store.size >= MAX_RATE_LIMIT_KEYS) {
            const first = rate_limit_store.keys().next().value;
            if (first) rate_limit_store.delete(first);
        }
        const new_data = {
            count: 1,
            reset_time: now + authConfig.rate_limit_window_ms,
        };
        rate_limit_store.set(client_id, new_data);
        return {
            allowed: true,
            remaining: authConfig.rate_limit_max_requests - 1,
            reset_time: new_data.reset_time,
        };
    }
    data.count++;
    rate_limit_store.set(client_id, data);
    const remaining = authConfig.rate_limit_max_requests - data.count;
    return {
        allowed: data.count <= authConfig.rate_limit_max_requests,
        remaining: Math.max(0, remaining),
        reset_time: data.reset_time,
    };
}

function get_client_id(ip: string | null, api_key: string | null): string {
    // SECURITY: Always use IP for rate limiting to prevent bypass via random key rotation.
    // Legitimate users sharing an NAT will share a limit.
    // TODO: Implement dual-layer limiting (IP for DOS protection, Key for Quota).
    if (ip) return `ip:${ip}`;

    // Fallback if IP extraction fails (should be rare)
    if (api_key)
        return crypto
            .createHash("sha256")
            .update(api_key)
            .digest("hex")
            .slice(0, 16);

    return "unknown_client";
}

function get_ip(request: Request, headers: any): string | null {
    // Support fetching from standard proxy headers (Headers object or plain map)
    const getHeader = (k: string) => {
        if (!headers) return undefined;
        if (typeof headers.get === "function") return headers.get(k);
        return headers[k] || headers[k.toLowerCase()];
    };
    const candidates = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip"];
    for (const c of candidates) {
        const v = getHeader(c);
        if (v) return String(v).split(",")[0].trim();
    }

    // Try Request socket / connection info
    try {
        const anyReq: any = request as any;
        if (anyReq.socket && anyReq.socket.remoteAddress) return anyReq.socket.remoteAddress;
        if (anyReq.ip) return anyReq.ip;
    } catch (e) {
        // ignore
    }

    return null;
}

// Elysia plugin for authentication
export const authPlugin = (app: Elysia) =>
    app.onBeforeHandle(({ request, set, path, headers }) => {
        if (is_public_endpoint(path)) return;

        // 1. Rate Limit Check (Before Auth) to prevent DoS brute-force
        const ip = get_ip(request, headers as any);
        const provided = extract_api_key(headers);

        // First, apply IP-based rate limiting as a DoS protection layer
        const ip_client_id = ip ? `ip:${ip}` : "ip:unknown";
        const ip_rl = check_rate_limit(ip_client_id);

        // Attach IP-based RL headers (global behavior)
        if (authConfig.rate_limit_enabled) {
            set.headers["X-RateLimit-Limit"] = String(authConfig.rate_limit_max_requests);
            set.headers["X-RateLimit-Remaining"] = String(ip_rl.remaining);
            set.headers["X-RateLimit-Reset"] = String(Math.floor(ip_rl.reset_time / 1000));
        }

        if (!ip_rl.allowed) {
            set.status = 429;
            return {
                error: "rate_limit_exceeded",
                retry_after: Math.ceil((ip_rl.reset_time - Date.now()) / 1000),
            };
        }

        if (!authConfig.api_key || authConfig.api_key === "") {
            return;
        }

        if (!provided) {
            set.status = 401;
            return {
                error: "authentication_required",
                message: "API key required",
            };
        }

        // Validate API key before applying per-key quota
        if (!validate_api_key(provided, authConfig.api_key)) {
            // Count failed key attempts separately to help detect brute force on keys
            const badKeyId = `badkey:${crypto.createHash("sha256").update(provided).digest("hex").slice(0,8)}`;
            check_rate_limit(badKeyId);
            set.status = 403;
            return { error: "invalid_api_key" };
        }

        // Apply per-key quota for valid keys
        const key_id = `key:${crypto.createHash("sha256").update(provided).digest("hex").slice(0,12)}`;
        const key_rl = check_rate_limit(key_id);
        // Expose key-level remaining quota in headers if available
        if (authConfig.rate_limit_enabled) {
            set.headers["X-RateLimit-User-Remaining"] = String(key_rl.remaining);
            set.headers["X-RateLimit-User-Reset"] = String(Math.floor(key_rl.reset_time / 1000));
        }
        if (!key_rl.allowed) {
            set.status = 429;
            return { error: "quota_exceeded", retry_after: Math.ceil((key_rl.reset_time - Date.now()) / 1000) };
        }
    });

// Log authenticated request
export const logAuthPlugin = (app: Elysia) =>
    app.onRequest(({ request, headers }) => {
        const key = extract_api_key(headers);
        if (key)
            log.info(
                `Request with Auth Credentials`, {
                    method: request.method,
                    path: new URL(request.url).pathname,
                    key_hash: crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)
                }
            );
    });

setInterval(
    () => {
        const now = Date.now();
        for (const [id, data] of rate_limit_store.entries())
            if (now >= data.reset_time) rate_limit_store.delete(id);
    },
    5 * 60 * 1000,
);
