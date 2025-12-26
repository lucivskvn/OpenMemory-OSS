import { authConfig } from "../../core/cfg";
import crypto from "crypto";
import { Elysia } from "elysia";
import { log } from "../../core/log";

const rate_limit_store = new Map<
    string,
    { count: number; reset_time: number }
>();
const MAX_RATE_LIMIT_KEYS = 10000;

function is_public_endpoint(path: string): boolean {
    return authConfig.public_endpoints.some(
        (e) => path === e || path.startsWith(e),
    );
}

function extract_api_key(headers: any): string | null {
    const x_api_key = headers[authConfig.api_key_header];
    if (x_api_key) return x_api_key;
    const auth_header = headers["authorization"];
    if (auth_header) {
        if (auth_header.startsWith("Bearer ")) return auth_header.slice(7);
        if (auth_header.startsWith("ApiKey ")) return auth_header.slice(7);
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

function get_ip(request: Request, headers: Record<string, string | undefined>): string | null {
    // 1. Check X-Forwarded-For (standard proxy header)
    const xff = headers["x-forwarded-for"];
    if (xff) return xff.split(",")[0].trim();

    // 2. Check direct connection info if available (Bun specific property)
    // Elysia request wrappers might obscure this, but request.headers is reliable for proxies.
    // Note: server.requestIP(request) is ideal but requires passing `app` context which we don't have easily here in the handler structure without refactoring.

    // Fallback logic
    return null;
}

// Elysia plugin for authentication
export const authPlugin = (app: Elysia) =>
    app.onBeforeHandle(({ request, set, path, headers }) => {
        if (is_public_endpoint(path)) return;

        // 1. Rate Limit Check (Before Auth) to prevent DoS brute-force
        const ip = get_ip(request, headers as any);
        const provided = extract_api_key(headers);

        // Use IP for rate limiting if Key is missing/invalid, or Key ID if valid?
        // To protect against brute force, we MUST rate limit by IP if auth fails.
        // But we don't know if auth fails yet.
        // Strategy: Rate limit by IP first. If IP is rate limited, block.
        // Then, if Key is valid, we could apply a separate "Quota" rate limit?
        // For simplicity/safety: Always check IP-based rate limit first for unauthenticated/invalid attempts.
        // However, shared IPs (NAT) might get blocked.
        // Hybrid approach:
        // If provided key is present, use a cheap hash of it for RL bucket (to allow valid high-traffic users).
        // If NO key or INVALID format, use IP.

        // For strict security, we'll use IP-based rate limiting as a first defense layer.
        // But `check_rate_limit` shares the store.
        // Let's use IP if provided is null.

        const client_id = get_client_id(ip, provided);
        const rl = check_rate_limit(client_id);

        if (authConfig.rate_limit_enabled) {
            set.headers["X-RateLimit-Limit"] = String(authConfig.rate_limit_max_requests);
            set.headers["X-RateLimit-Remaining"] = String(rl.remaining);
            set.headers["X-RateLimit-Reset"] = String(Math.floor(rl.reset_time / 1000));
        }

        if (!rl.allowed) {
            set.status = 429;
            return {
                error: "rate_limit_exceeded",
                retry_after: Math.ceil((rl.reset_time - Date.now()) / 1000),
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

        if (!validate_api_key(provided, authConfig.api_key)) {
            set.status = 403;
            return { error: "invalid_api_key" };
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
