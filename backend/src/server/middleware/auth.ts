import { env } from "../../core/cfg";
import { CryptoHasher } from "bun";
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

    // Securely verify the provided key against the stored hash.
    return await Bun.password.verify(provided, hashed_expected);
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
        return new CryptoHasher("sha256")
            .update(api_key)
            .digest("hex")
            .slice(0, 16);
    return req.headers.get("x-forwarded-for") || "unknown";
}

export async function authenticate_api_request(req: Request, ctx: Context, next: () => Promise<Response>) {
    const url = new URL(req.url);
    if (is_public_endpoint(url.pathname)) return next();

    if (!auth_config.api_key || auth_config.api_key === "") {
        logger.warn({ component: "AUTH" }, "No API key configured, allowing all requests.");
        return next();
    }

    const provided = extract_api_key(req);
    if (!provided) {
        return new Response(JSON.stringify({ error: "authentication_required", message: "API key required" }),
            { status: 401, headers: { "Content-Type": "application/json" } });
    }

    if (!await validate_api_key(provided, auth_config.api_key)) {
        return new Response(JSON.stringify({ error: "invalid_api_key" }),
            { status: 403, headers: { "Content-Type": "application/json" } });
    }

    const client_id = get_client_id(req, provided);
    const rl = check_rate_limit(client_id);

    const response = await next();

    if (auth_config.rate_limit_enabled) {
        response.headers.set("X-RateLimit-Limit", auth_config.rate_limit_max_requests.toString());
        response.headers.set("X-RateLimit-Remaining", rl.remaining.toString());
        response.headers.set("X-RateLimit-Reset", Math.floor(rl.reset_time / 1000).toString());
    }

    if (!rl.allowed) {
        return new Response(JSON.stringify({ error: "rate_limit_exceeded", retry_after: Math.ceil((rl.reset_time - Date.now()) / 1000) }),
            { status: 429, headers: { "Content-Type": "application/json" } });
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
            key_hash: new CryptoHasher("sha256").update(key).digest("hex").slice(0, 8)
        }, "Authenticated request");
    }
    return next();
}

setInterval(
    () => {
        const now = Date.now();
        for (const [id, data] of rate_limit_store.entries())
            if (now >= data.reset_time) rate_limit_store.delete(id);
    },
    5 * 60 * 1000,
);
