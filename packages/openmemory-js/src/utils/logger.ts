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

const SENSITIVE_KEYS = [
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

export const redact = (obj: unknown, stack = new Set<unknown>()): unknown => {
    if (!obj) return obj;
    if (typeof obj === "string") return obj;
    if (typeof obj === "number" || typeof obj === "boolean") return obj;

    if (stack.has(obj)) return "[Circular]";
    stack.add(obj);

    try {
        if (Array.isArray(obj)) {
            return obj.map((i) => redact(i, stack));
        }

        if (typeof obj === "object") {
            const newObj: Record<string, unknown> = {};
            for (const k in obj) {
                // Safe key access for unknown object
                if (Object.prototype.hasOwnProperty.call(obj, k)) {
                    const val = (obj as Record<string, unknown>)[k];
                    if (
                        SENSITIVE_KEYS.some((sk) =>
                            k.toLowerCase().includes(sk.toLowerCase()),
                        )
                    ) {
                        newObj[k] = "***REDACTED***";
                    } else {
                        newObj[k] = redact(val, stack);
                    }
                }
            }
            return newObj;
        }
        return obj;
    } finally {
        stack.delete(obj);
    }
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
        const safeMeta = meta ? redact(meta) : undefined;

        if (config.mode === "production") {
            // JSON Output
            // eslint-disable-next-line no-console
            const logFn = level === "error" ? console.error : console.log;
            logFn(
                JSON.stringify({
                    timestamp,
                    level,
                    message,
                    ...(safeMeta as object),
                }),
            );
        } else {
            // Human Readable
            const metaStr = safeMeta ? ` ${JSON.stringify(safeMeta)}` : "";
            const prefix = `[${timestamp}] ${level.toUpperCase()}:`;
            // eslint-disable-next-line no-console
            const logFn = level === "error" ? console.error : console.log;
            logFn(`${color(level, prefix)} ${message}${metaStr}`);
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
export const configureLogger = (cfg: Partial<LoggerConfig>) =>
    logger.configure(cfg);
