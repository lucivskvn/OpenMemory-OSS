// Structured logger implementation with redaction and safety

const SENSITIVE_KEYS = [
    "password",
    "secret",
    "token",
    "api_key",
    "openai_key",
    "gemini_key",
    "aws_secret_access_key",
    "authorization",
    "bearer",
];

// Whitelist for common non-sensitive keys that might trigger broad rules
const SAFE_KEYS = ["tokens", "estimated_tokens", "total_tokens", "max_tokens", "child_count", "id", "hash", "key_hash"];

const isSensitive = (key: string) => {
    const lower = key.toLowerCase();
    if (SAFE_KEYS.includes(lower) || SAFE_KEYS.some(safe => lower.endsWith(safe))) return false;

    // Redact if key matches sensitive list, but exclude safe suffixes like 'hash' or 'id' if specific
    // Strict inclusion check for 'key' is too broad (e.g. 'primary_key'), so we use explicit list + 'token'/'secret' generic
    if (lower.includes("token") || lower.includes("secret") || lower.includes("password")) return true;
    return SENSITIVE_KEYS.some(k => lower === k || lower.endsWith(`_${k}`) || lower.startsWith(`${k}_`));
};

const redact = (obj: any, seen = new WeakSet()): any => {
    if (obj === null || typeof obj !== "object") return obj;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);

    if (Array.isArray(obj)) {
        return obj.map(v => redact(v, seen));
    }

    if (obj instanceof Error) {
        return serializeError(obj);
    }

    const newObj: any = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            if (isSensitive(key)) {
                newObj[key] = "***";
            } else {
                newObj[key] = redact(obj[key], seen);
            }
        }
    }
    return newObj;
};

const serializeError = (err: any) => {
    if (err instanceof Error) {
        return {
            message: err.message,
            stack: err.stack,
            name: err.name,
            ...err, // include custom properties
        };
    }
    return err;
};

const format = (level: string, message: string, meta?: any) => {
    const timestamp = new Date().toISOString();

    // Redact meta before stringify
    const safeMeta = meta ? redact(meta) : undefined;

    return JSON.stringify({
        timestamp,
        level,
        message,
        ...(safeMeta && typeof safeMeta === 'object' ? safeMeta : { meta: safeMeta }),
    });
};

export const log = {
    info: (message: string, meta?: any) => console.log(format("INFO", message, meta)),
    error: (message: string, meta?: any) => console.error(format("ERROR", message, meta)),
    warn: (message: string, meta?: any) => console.warn(format("WARN", message, meta)),
    debug: (message: string, meta?: any) => {
        if (process.env.DEBUG) console.debug(format("DEBUG", message, meta));
    },
};
