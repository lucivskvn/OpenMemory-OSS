import { env } from "../../core/cfg";
import { timingSafeEqual } from "node:crypto";

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

function extract_api_key(req: any): string | null {
    const x_api_key = req.headers[auth_config.api_key_header];
    if (x_api_key) return x_api_key;
    const auth_header = req.headers["authorization"];
    if (auth_header) {
        if (auth_header.startsWith("Bearer ")) return auth_header.slice(7);
        if (auth_header.startsWith("ApiKey ")) return auth_header.slice(7);
    }
    return null;
}

function validate_api_key(provided: string, expected: string): boolean {
    if (!provided || !expected || provided.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
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

async function get_client_id(req: any, api_key: string | null): Promise<string> {
    if (api_key) {
        const hash = await crypto.subtle.digest("SHA-256", Buffer.from(api_key));
        return Buffer.from(hash).toString("hex").slice(0, 16);
    }
    return req.ip || req.connection.remoteAddress || "unknown";
}

export async function authenticate_api_request(req: any, res: any, next: any) {
    try {
        const path = req.path || req.url;
        if (is_public_endpoint(path)) return next();
        if (!auth_config.api_key || auth_config.api_key === "") {
            return next();
        }
        const provided = extract_api_key(req);
        if (!provided)
            return res
                .status(401)
                .json({
                    error: "authentication_required",
                    message: "This server requires an API key for access. Please provide it in the 'x-api-key' header or as a Bearer token.",
                });
        if (!validate_api_key(provided, auth_config.api_key))
            return res.status(403).json({ error: "invalid_api_key", message: "The provided API key is incorrect." });
        const client_id = await get_client_id(req, provided);
        req.user = { id: client_id };

        const rl = check_rate_limit(client_id);
        if (auth_config.rate_limit_enabled) {
            res.setHeader("X-RateLimit-Limit", auth_config.rate_limit_max_requests);
            res.setHeader("X-RateLimit-Remaining", rl.remaining);
            res.setHeader("X-RateLimit-Reset", Math.floor(rl.reset_time / 1000));
        }
        if (!rl.allowed)
            return res.status(429).json({
                error: "rate_limit_exceeded",
                retry_after: Math.ceil((rl.reset_time - Date.now()) / 1000),
            });
        next();
    } catch (e) {
        next(e);
    }
}

export async function log_authenticated_request(req: any, res: any, next: any) {
    try {
        const key = extract_api_key(req);
        if (key) {
            const hash = await crypto.subtle.digest("SHA-256", Buffer.from(key));
            const hex = Buffer.from(hash).toString("hex").slice(0, 8);
            console.log(`[AUTH] ${req.method} ${req.path} [${hex}...]`);
        }
        next();
    } catch (e) {
        console.error("[AUTH] Logging failed:", e);
        next();
    }
}

setInterval(
    () => {
        const now = Date.now();
        for (const [id, data] of rate_limit_store.entries())
            if (now >= data.reset_time) rate_limit_store.delete(id);
    },
    5 * 60 * 1000,
);
