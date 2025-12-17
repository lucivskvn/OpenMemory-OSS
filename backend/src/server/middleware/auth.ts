import { env } from "../../core/cfg";
import crypto from "crypto";
import { Elysia } from "elysia";

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

function extract_api_key(headers: any): string | null {
    const x_api_key = headers[auth_config.api_key_header];
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

function get_client_id(ip: string, api_key: string | null): string {
    if (api_key)
        return crypto
            .createHash("sha256")
            .update(api_key)
            .digest("hex")
            .slice(0, 16);
    return ip || "unknown";
}

// Elysia plugin for authentication
export const authPlugin = (app: Elysia) =>
    app.onBeforeHandle(({ request, set, path, headers }) => {
        if (is_public_endpoint(path)) return;

        if (!auth_config.api_key || auth_config.api_key === "") {
            // console.warn("[AUTH] No API key configured");
            return;
        }

        const provided = extract_api_key(headers);
        if (!provided) {
            set.status = 401;
            return {
                error: "authentication_required",
                message: "API key required",
            };
        }

        if (!validate_api_key(provided, auth_config.api_key)) {
            set.status = 403;
            return { error: "invalid_api_key" };
        }

        // Rate limiting logic
        // Need IP. Elysia request object has headers.
        // Assuming IP is in X-Forwarded-For or similar if proxied, or we skip IP for now.
        // Or use `server.requestIP(request)` if available in context?
        // Elysia's `ip` property is available in recent versions if configured.
        // For now, use provided key as client ID if available, else skip IP check or default.
        const client_id = get_client_id("unknown", provided);
        const rl = check_rate_limit(client_id);

        if (auth_config.rate_limit_enabled) {
            set.headers["X-RateLimit-Limit"] = String(auth_config.rate_limit_max_requests);
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
    });

// Log authenticated request
export const logAuthPlugin = (app: Elysia) =>
    app.onRequest(({ request, headers }) => {
        const key = extract_api_key(headers);
        if (key)
            console.log(
                `[AUTH] ${request.method} ${new URL(request.url).pathname} [${crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)}...]`,
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
