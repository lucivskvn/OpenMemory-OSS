/**
 * Structured Logger for OpenMemory
 * Outputs JSON in production, colored text in development.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

interface LoggerConfig {
    mode: string;
    verbose: boolean;
    logLevel?: string;
}

let config: LoggerConfig = {
    mode: "production", // Default to production/safe for client
    verbose: false,
};

const color = (level: LogLevel, text: string) => {
    if (config.mode === "production") return text;
    const colors = {
        debug: "\x1b[36m", // Cyan
        info: "\x1b[32m", // Green
        warn: "\x1b[33m", // Yellow
        error: "\x1b[31m", // Red
    };
    return `${colors[level]}${text}\x1b[0m`;
};

export const SENSITIVE_KEYS = [
    "api_key",
    "apiKey",
    "apikey",
    "password",
    "pass",
    "passwd",
    "token",
    "authToken",
    "authtoken",
    "accessToken",
    "refreshToken",
    "secret",
    "clientSecret",
    "clientsecret",
    "authorization",
    "auth",
    "bearer",
    "key",
    "encryptionKey",
    "encryption_key",
    "privateKey",
    "private_key",
    "cookie",
    "session",
    "jwt",
    "credit_card",
    "cc_number",
    "ssn",
    "email",
    "phone",
    "phonenumber",
    "address",
    "zipcode",
    "cvv",
    "cvc",
    "pin",
    "routing_number",
    "account_number",
    "dsn",
    "connection_string",
    "connectionString",
    "database_url",
    "url", // Often contains creds in connection strings
];
const SENSITIVE_PATTERN = /sk-ant-[a-zA-Z0-9-_]{20,}|sk-or-[a-zA-Z0-9-_]{20,}|sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9-_]{20,}|gsk_[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|glpat-[a-zA-Z0-9-_]{20,}/g;
const SECRET_REPLACEMENT = "[REDACTED]";

const REDACT_KEYS = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/**
 * Redacts sensitive information from an object or string.
 * Optimized for performance with depth limits and binary data skipping.
 */
export const redact = (obj: unknown, depth = 0, seen = new WeakSet()): unknown => {
    if (!obj) return obj;
    if (depth > 5) return "[DEPTH_LIMIT]";

    // Handle string redaction (API keys, etc.)
    // Parse string if it looks like JSON
    if (typeof obj === "string") {
        // Redact patterns in the string
        return obj
            .replace(SENSITIVE_PATTERN, (match) => match.slice(0, 7) + SECRET_REPLACEMENT)
            .replace(/(?<=key=)[a-zA-Z0-9-_]{20,}/gi, SECRET_REPLACEMENT)
            .replace(/(?<=Authorization: Bearer )[a-zA-Z0-9.\-_]{20,}/gi, SECRET_REPLACEMENT)
            .replace(/(?<=x-api-key: )[a-zA-Z0-9-_]{20,}/gi, SECRET_REPLACEMENT)
            .replace(/(?<=x-goog-api-key: )[a-zA-Z0-9-_]{20,}/gi, SECRET_REPLACEMENT);
    }

    if (typeof obj !== "object" || obj === null) return obj;

    // Performance: Skip binary data and large buffers
    if (obj instanceof Uint8Array) return "[BINARY]";

    if (seen.has(obj)) return "[CIRCULAR]";
    seen.add(obj);

    if (Array.isArray(obj)) {
        return obj.slice(0, 100).map((v) => redact(v, depth + 1, seen));
    }

    if (obj instanceof Map) {
        const result = new Map();
        for (const [key, value] of obj.entries()) {
            if (result.size > 100) break; // Limit Map size
            if (typeof key === 'string' && REDACT_KEYS.has(key.toLowerCase())) {
                result.set(key, SECRET_REPLACEMENT);
            } else {
                result.set(key, redact(value, depth + 1, seen));
            }
        }
        return result;
    }

    if (obj instanceof Set) {
        const result = new Set();
        for (const value of obj.values()) {
            if (result.size > 100) break;
            result.add(redact(value, depth + 1, seen));
        }
        return result;
    }

    if (obj instanceof Error) {
        return {
            name: obj.name,
            message: redact(obj.message, depth + 1, seen),
            stack: redact(obj.stack, depth + 1, seen),
            cause: (obj as Error).cause ? redact((obj as Error).cause, depth + 1, seen) : undefined
        };
    }

    const result: Record<string, unknown> = {};
    const entries = Object.entries(obj);
    if (entries.length > 500) return "[TOO_MANY_KEYS]";

    for (const [key, value] of entries) {
        if (REDACT_KEYS.has(key.toLowerCase())) {
            result[key] = SECRET_REPLACEMENT;
        } else {
            result[key] = redact(value, depth + 1, seen);
        }
    }
    return result;
};

class Logger {
    configure(newConfig: Partial<LoggerConfig>) {
        config = { ...config, ...newConfig };
    }

    private log(
        level: LogLevel,
        message: string,
        meta?: Record<string, unknown>,
    ) {
        const configuredLevel =
            config.logLevel || (config.verbose ? "debug" : "info");
        const currentLevel = LEVELS[configuredLevel as LogLevel] ?? LEVELS.info;

        if (LEVELS[level] < currentLevel) return;

        const timestamp = new Date().toISOString();
        const safeMsg = redact(message) as string;
        const safeMeta = meta ? redact(meta) : undefined;

        if (config.mode === "production") {
            // JSON Output
            // eslint-disable-next-line no-console
            const logFn = level === "error" ? console.error : console.log;
            logFn(
                JSON.stringify({
                    timestamp,
                    level,
                    message: safeMsg,
                    ...(safeMeta as object),
                }),
            );
        } else {
            // Human Readable
            const metaStr = safeMeta ? ` ${JSON.stringify(safeMeta)}` : "";
            const prefix = `[${timestamp}] ${level.toUpperCase()}:`;
            // eslint-disable-next-line no-console
            const logFn = level === "error" ? console.error : console.log;
            logFn(`${color(level, prefix)} ${safeMsg}${metaStr}`);
        }
    }

    debug(msg: string, meta?: Record<string, unknown>) {
        this.log("debug", msg, meta);
    }
    info(msg: string, meta?: Record<string, unknown>) {
        this.log("info", msg, meta);
    }
    warn(msg: string, meta?: Record<string, unknown>) {
        this.log("warn", msg, meta);
    }
    error(msg: string, meta?: Record<string, unknown>) {
        this.log("error", msg, meta);
    }
}

export const logger = new Logger();
export const configureLogger = (cfg: Partial<LoggerConfig>) => {
    if (logger) {
        logger.configure(cfg);
    }
};
