/**
 * Structured Logger for OpenMemory
 * Outputs JSON in production, colored text in development.
 * Enhanced with correlation ID tracking and request tracing.
 */

import { AsyncLocalStorage } from "node:async_hooks";

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

interface TraceContext {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    userId?: string;
    requestId?: string;
    operation?: string;
    startTime?: number;
    metadata?: Record<string, unknown>;
}

// AsyncLocalStorage for correlation ID tracking
const traceStorage = new AsyncLocalStorage<TraceContext>();

let config: LoggerConfig = {
    mode: "production", // Default to production/safe for client
    verbose: false,
};

/**
 * Correlation ID and Tracing Utilities
 */

/**
 * Generate a unique trace ID
 */
export function generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a unique span ID
 */
export function generateSpanId(): string {
    return `span_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get the current trace context
 */
export function getCurrentTraceContext(): TraceContext | undefined {
    return traceStorage.getStore();
}

/**
 * Set trace context for the current execution
 */
export function setTraceContext(context: TraceContext): void {
    // This is used internally by runWithTrace
}

/**
 * Run a function with trace context
 */
export function runWithTrace<T>(
    context: Partial<TraceContext>,
    fn: () => T | Promise<T>
): T | Promise<T> {
    const fullContext: TraceContext = {
        traceId: context.traceId || generateTraceId(),
        spanId: context.spanId || generateSpanId(),
        parentSpanId: context.parentSpanId,
        userId: context.userId,
        requestId: context.requestId,
        operation: context.operation,
        startTime: context.startTime || Date.now(),
        metadata: context.metadata,
    };

    return traceStorage.run(fullContext, fn);
}

/**
 * Create a child span within the current trace
 */
export function createChildSpan(
    operation: string,
    metadata?: Record<string, unknown>
): TraceContext {
    const parent = getCurrentTraceContext();
    return {
        traceId: parent?.traceId || generateTraceId(),
        spanId: generateSpanId(),
        parentSpanId: parent?.spanId,
        userId: parent?.userId,
        requestId: parent?.requestId,
        operation,
        startTime: Date.now(),
        metadata: { ...parent?.metadata, ...metadata },
    };
}

/**
 * Middleware helper to extract trace context from headers
 */
export function extractTraceFromHeaders(headers: Record<string, string | undefined>): Partial<TraceContext> {
    return {
        traceId: headers['x-trace-id'] || headers['traceparent']?.split('-')[1],
        spanId: headers['x-span-id'],
        parentSpanId: headers['x-parent-span-id'],
        userId: headers['x-user-id'],
        requestId: headers['x-request-id'] || headers['request-id'],
    };
}

/**
 * Inject trace context into headers
 */
export function injectTraceIntoHeaders(context?: TraceContext): Record<string, string> {
    const ctx = context || getCurrentTraceContext();
    if (!ctx) return {};

    const headers: Record<string, string> = {};
    if (ctx.traceId) headers['x-trace-id'] = ctx.traceId;
    if (ctx.spanId) headers['x-span-id'] = ctx.spanId;
    if (ctx.parentSpanId) headers['x-parent-span-id'] = ctx.parentSpanId;
    if (ctx.userId) headers['x-user-id'] = ctx.userId;
    if (ctx.requestId) headers['x-request-id'] = ctx.requestId;
    
    return headers;
}

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
    // Additional PII patterns
    "firstName",
    "first_name",
    "lastName",
    "last_name",
    "fullName",
    "full_name",
    "dateOfBirth",
    "date_of_birth",
    "dob",
    "birthDate",
    "birth_date",
    "socialSecurityNumber",
    "social_security_number",
    "driversLicense",
    "drivers_license",
    "passport",
    "passportNumber",
    "passport_number",
    "nationalId",
    "national_id",
    "taxId",
    "tax_id",
    "bankAccount",
    "bank_account",
    "iban",
    "swift",
    "bic",
    "creditCard",
    "debitCard",
    "debit_card",
    "ipAddress",
    "ip_address",
    "macAddress",
    "mac_address",
    "deviceId",
    "device_id",
    "userId",
    "user_id",
    "username",
    "user_name",
    "loginId",
    "login_id",
];

// Enhanced PII detection patterns
const SENSITIVE_PATTERN = /sk-ant-[a-zA-Z0-9-_]{20,}|sk-or-[a-zA-Z0-9-_]{20,}|sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9-_]{20,}|gsk_[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|glpat-[a-zA-Z0-9-_]{20,}/g;

// Additional PII patterns for content detection
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const PHONE_PATTERN = /(\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/g;
const SSN_PATTERN = /\b\d{3}-?\d{2}-?\d{4}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const IP_ADDRESS_PATTERN = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g;
const MAC_ADDRESS_PATTERN = /\b([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})\b/g;
const SECRET_REPLACEMENT = "[REDACTED]";

const REDACT_KEYS = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/**
 * Redacts sensitive information from an object or string.
 * Optimized for performance with depth limits and binary data skipping.
 * Enhanced with comprehensive PII detection patterns.
 */
export const redact = (obj: unknown, depth = 0, seen = new WeakSet()): unknown => {
    if (!obj) return obj;
    if (depth > 5) return "[DEPTH_LIMIT]";

    // Handle string redaction (API keys, PII, etc.)
    if (typeof obj === "string") {
        // Redact API key patterns
        let redacted = obj
            .replace(SENSITIVE_PATTERN, (match) => match.slice(0, 7) + SECRET_REPLACEMENT)
            .replace(/(?<=key=)[a-zA-Z0-9-_]{20,}/gi, SECRET_REPLACEMENT)
            .replace(/(?<=Authorization: Bearer )[a-zA-Z0-9.\-_]{20,}/gi, SECRET_REPLACEMENT)
            .replace(/(?<=x-api-key: )[a-zA-Z0-9-_]{20,}/gi, SECRET_REPLACEMENT)
            .replace(/(?<=x-goog-api-key: )[a-zA-Z0-9-_]{20,}/gi, SECRET_REPLACEMENT);

        // Redact PII patterns
        redacted = redacted
            .replace(EMAIL_PATTERN, (match) => {
                const [local, domain] = match.split('@');
                return `${local.slice(0, 2)}***@${domain}`;
            })
            .replace(PHONE_PATTERN, '***-***-****')
            .replace(SSN_PATTERN, '***-**-****')
            .replace(CREDIT_CARD_PATTERN, '**** **** **** ****')
            .replace(IP_ADDRESS_PATTERN, (match) => {
                const parts = match.split('.');
                return `${parts[0]}.${parts[1]}.***.***.`;
            })
            .replace(MAC_ADDRESS_PATTERN, '**:**:**:**:**:**');

        return redacted;
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

/**
 * Detect if a string contains potential PII
 */
export function containsPII(text: string): boolean {
    if (!text || typeof text !== 'string') return false;
    
    return EMAIL_PATTERN.test(text) ||
           PHONE_PATTERN.test(text) ||
           SSN_PATTERN.test(text) ||
           CREDIT_CARD_PATTERN.test(text) ||
           IP_ADDRESS_PATTERN.test(text) ||
           MAC_ADDRESS_PATTERN.test(text) ||
           SENSITIVE_PATTERN.test(text);
}

/**
 * Get PII types detected in a string
 */
export function detectPIITypes(text: string): string[] {
    if (!text || typeof text !== 'string') return [];
    
    const types: string[] = [];
    
    if (EMAIL_PATTERN.test(text)) types.push('email');
    if (PHONE_PATTERN.test(text)) types.push('phone');
    if (SSN_PATTERN.test(text)) types.push('ssn');
    if (CREDIT_CARD_PATTERN.test(text)) types.push('credit_card');
    if (IP_ADDRESS_PATTERN.test(text)) types.push('ip_address');
    if (MAC_ADDRESS_PATTERN.test(text)) types.push('mac_address');
    if (SENSITIVE_PATTERN.test(text)) types.push('api_key');
    
    return types;
}

/**
 * Sanitize data for safe storage/transmission
 */
export function sanitizeForStorage(data: unknown): unknown {
    return redact(data);
}

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

        // Get current trace context for correlation
        const traceContext = getCurrentTraceContext();
        
        // Build log entry with trace information
        const logEntry: Record<string, unknown> = {
            timestamp,
            level,
            message: safeMsg,
            ...(safeMeta as object),
        };

        // Add trace context if available
        if (traceContext) {
            logEntry.traceId = traceContext.traceId;
            logEntry.spanId = traceContext.spanId;
            if (traceContext.parentSpanId) {
                logEntry.parentSpanId = traceContext.parentSpanId;
            }
            if (traceContext.userId) {
                logEntry.userId = traceContext.userId;
            }
            if (traceContext.requestId) {
                logEntry.requestId = traceContext.requestId;
            }
            if (traceContext.operation) {
                logEntry.operation = traceContext.operation;
            }
        }

        if (config.mode === "production") {
            // JSON Output with trace context
            // eslint-disable-next-line no-console
            const logFn = level === "error" ? console.error : console.log;
            logFn(JSON.stringify(logEntry));
        } else {
            // Human Readable with trace context
            const metaStr = safeMeta ? ` ${JSON.stringify(safeMeta)}` : "";
            const traceStr = traceContext 
                ? ` [trace:${traceContext.traceId.slice(-8)}${traceContext.operation ? `:${traceContext.operation}` : ''}]`
                : "";
            const prefix = `[${timestamp}] ${level.toUpperCase()}:`;
            // eslint-disable-next-line no-console
            const logFn = level === "error" ? console.error : console.log;
            logFn(`${color(level, prefix)} ${safeMsg}${traceStr}${metaStr}`);
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

    /**
     * Log with explicit trace context (useful for cross-service calls)
     */
    withTrace(traceContext: TraceContext) {
        return {
            debug: (msg: string, meta?: Record<string, unknown>) => 
                runWithTrace(traceContext, () => this.debug(msg, meta)),
            info: (msg: string, meta?: Record<string, unknown>) => 
                runWithTrace(traceContext, () => this.info(msg, meta)),
            warn: (msg: string, meta?: Record<string, unknown>) => 
                runWithTrace(traceContext, () => this.warn(msg, meta)),
            error: (msg: string, meta?: Record<string, unknown>) => 
                runWithTrace(traceContext, () => this.error(msg, meta)),
        };
    }

    /**
     * Create a traced operation that logs start/end with duration
     */
    async traceOperation<T>(
        operation: string,
        fn: () => Promise<T>,
        metadata?: Record<string, unknown>
    ): Promise<T> {
        const span = createChildSpan(operation, metadata);
        const startTime = Date.now();
        
        return runWithTrace(span, async () => {
            this.debug(`Starting operation: ${operation}`, { operation, ...metadata });
            
            try {
                const result = await fn();
                const duration = Date.now() - startTime;
                this.info(`Completed operation: ${operation}`, { 
                    operation, 
                    duration, 
                    success: true,
                    ...metadata 
                });
                return result;
            } catch (error) {
                const duration = Date.now() - startTime;
                this.error(`Failed operation: ${operation}`, { 
                    operation, 
                    duration, 
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    ...metadata 
                });
                throw error;
            }
        });
    }
}

export const logger = new Logger();
export const configureLogger = (cfg: Partial<LoggerConfig>) => {
    if (logger) {
        logger.configure(cfg);
    }
};
