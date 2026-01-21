/**
 * Base Source Connector Framework for OpenMemory.
 * Provides abstraction for authentication, rate limiting, retries, and ingestion flows.
 */
import { normalizeUserId } from "../utils";
import { logger } from "../utils/logger";

// -- exceptions --

/**
 * Base error class for all Source/Connector related exceptions.
 */
export class SourceError extends Error {
    source?: string;
    cause?: Error;

    constructor(msg: string, source?: string, cause?: Error) {
        super(source ? `[${source}] ${msg}` : msg);
        this.name = "SourceError";
        this.source = source;
        this.cause = cause;
    }
}

export class SourceAuthError extends SourceError {
    constructor(msg: string, source?: string, cause?: Error) {
        super(msg, source, cause);
        this.name = "SourceAuthError";
    }
}

export class SourceConfigError extends SourceError {
    constructor(msg: string, source?: string, cause?: Error) {
        super(msg, source, cause);
        this.name = "SourceConfigError";
    }
}

export class SourceRateLimitError extends SourceError {
    retryAfter?: number;

    constructor(msg: string, retryAfter?: number, source?: string) {
        super(msg, source);
        this.name = "SourceRateLimitError";
        this.retryAfter = retryAfter;
    }
}

export class SourceFetchError extends SourceError {
    constructor(msg: string, source?: string, cause?: Error) {
        super(msg, source, cause);
        this.name = "SourceFetchError";
    }
}

// -- types --

export interface SourceItem {
    id: string;
    name: string;
    type: string;
    [key: string]: unknown;
}

export interface SourceContent {
    id: string;
    name: string;
    type: string;
    text: string;
    data: string | Buffer;
    metadata: Record<string, unknown>;
}

export interface SourceConfig {
    maxRetries?: number;
    requestsPerSecond?: number;
    logLevel?: "debug" | "info" | "warn" | "error";
}

// -- rate limiter --

/**
 * Token bucket rate limiter implementation.
 * Ensures that requests do not exceed a specified rate per second.
 */
export class RateLimiter {
    private requestsPerSecond: number;
    private tokens: number;
    private lastUpdate: number;

    /**
     * @param requestsPerSecond Max requests allowed per second. Default 10.
     */
    constructor(requestsPerSecond: number = 10) {
        this.requestsPerSecond = requestsPerSecond;
        this.tokens = requestsPerSecond;
        this.lastUpdate = Date.now();
    }

    /**
     * Acquire a token. Blocks if rate limit is exceeded.
     */
    async acquire(): Promise<void> {
        const now = Date.now();
        const elapsed = (now - this.lastUpdate) / 1000;

        // Refill tokens
        this.tokens = Math.min(
            this.requestsPerSecond,
            this.tokens + elapsed * this.requestsPerSecond,
        );
        this.lastUpdate = now;

        // Claim a token immediately (can go negative for queueing)
        this.tokens -= 1;

        if (this.tokens < 0) {
            // How long to wait until this token is available?
            // If tokens = -1, wait = 1/RPS
            // If tokens = -5, wait = 5/RPS
            const waitTime = Math.abs(this.tokens / this.requestsPerSecond) * 1000;

            if (typeof Bun !== 'undefined' && Bun.sleep) {
                await Bun.sleep(waitTime);
            } else {
                await new Promise((r) => setTimeout(r, waitTime));
            }
        }
    }
}

// -- retry helper --

/**
 * Executes a function with exponential backoff retry logic.
 * @param fn Async function to execute
 * @param maxAttempts Maximum number of attempts (default 3)
 * @param baseDelay Initial delay in ms (default 1000)
 * @param maxDelay Maximum delay cap in ms (default 60000)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 3,
    baseDelay: number = 1000,
    maxDelay: number = 60000,
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (e: unknown) {
            lastError = e instanceof Error ? e : new Error(String(e));

            if (e instanceof SourceAuthError) {
                throw e; // don't retry auth errors
            }

            if (attempt < maxAttempts - 1) {
                const delay =
                    e instanceof SourceRateLimitError && e.retryAfter
                        ? e.retryAfter * 1000
                        : Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

                const msg = e instanceof Error ? e.message : String(e);
                logger.warn(
                    `[RETRY] Attempt ${attempt + 1}/${maxAttempts} failed: ${msg}. Retrying in ${delay}ms`,
                );
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    throw lastError;
}

// -- base source --

/**
 * Abstract base class for all data sources (connectors).
 * Handles:
 * - Connection management
 * - Rate limiting
 * Base class for all OpenMemory Source Connectors.
 * Provides a standardized interface for authentication, rate limiting, and item ingestion.
 * Implements a "Dashboard-First" integration strategy, prioritizing database-backed config.
 *
 * @template TCreds - The credential type for the source.
 * @template TFilters - The filter type for listing items.
 */
export abstract class BaseSource<
    TCreds = Record<string, unknown>,
    TFilters = Record<string, unknown>,
> {
    name: string = "base";
    userId: string | null | undefined;
    protected _connected: boolean = false;
    protected _maxRetries: number;
    protected _rateLimiter: RateLimiter;

    constructor(userId?: string | null, config?: SourceConfig) {
        this.userId = normalizeUserId(userId);
        this._maxRetries = config?.maxRetries || 3;
        const rps = config?.requestsPerSecond || 5; // Sustainabilty default: 5 req/sec
        this._rateLimiter = new RateLimiter(rps);
    }

    get rateLimiter(): RateLimiter {
        return this._rateLimiter;
    }

    get connected(): boolean {
        return this._connected;
    }

    /**
     * Authenticates the source connector.
     * Automatically hydrates credentials from the database (Dashboard-First) if available.
     *
     * @param creds - Explicitly provided credentials (optional).
     * @returns {Promise<boolean>} True if connection succeeded.
     * @throws {SourceAuthError} If authentication fails.
     */
    async connect(creds?: TCreds): Promise<boolean> {
        logger.info(`[${this.name}] Connecting (centralized auth)...`);
        try {
            // 1. Try to hydrate from DB first (Dashboard-First Integration Strategy)
            const { getPersistedConfig } = await import("../core/persisted_cfg");
            const persisted = await getPersistedConfig<TCreds>(
                this.userId ?? null,
                this.name,
            );

            // 2. Priority: Provided > Persisted > (Subclass fallback to Env)
            const finalCreds = { ...persisted, ...creds } as TCreds;

            const result = await this._connect(finalCreds);
            this._connected = result;
            if (result) {
                logger.info(`[${this.name}] Connected successfully`);
            }
            return result;
        } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            logger.error(`[${this.name}] Connection failed: ${err.message}`);
            throw new SourceAuthError(err.message, this.name, err);
        }
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        logger.info(`[${this.name}] Disconnected`);
    }

    async listItems(filters?: TFilters): Promise<SourceItem[]> {
        if (!this._connected) {
            await this.connect();
        }

        await this._rateLimiter.acquire();

        try {
            const items = await withRetry(
                () => this._listItems(filters || ({} as TFilters)),
                this._maxRetries,
            );
            logger.info(`[${this.name}] Found ${items.length} items`);
            return items;
        } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            throw new SourceFetchError(err.message, this.name, err);
        }
    }

    async fetchItem(itemId: string): Promise<SourceContent> {
        if (!this._connected) {
            await this.connect();
        }

        await this._rateLimiter.acquire();

        try {
            return await withRetry(
                () => this._fetchItem(itemId),
                this._maxRetries,
            );
        } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            throw new SourceFetchError(err.message, this.name, err);
        }
    }

    async ingestAll(filters?: TFilters): Promise<{
        successfulIds: string[];
        errors: { id: string; error: string }[];
    }> {
        const { ingestDocument } = await import("../ops/ingest");

        const items = await this.listItems(filters);
        const successfulIds: string[] = [];
        const errors: { id: string; error: string }[] = [];
        const CONCURRENCY_LIMIT = 5;

        logger.info(`[${this.name}] Ingesting ${items.length} items (pool concurrency=${CONCURRENCY_LIMIT})...`);

        let activeCount = 0;
        let index = 0;

        return new Promise((resolve) => {
            const next = async () => {
                if (index >= items.length && activeCount === 0) {
                    logger.info(`[${this.name}] Ingested ${successfulIds.length} items, ${errors.length} errors`);
                    resolve({ successfulIds, errors });
                    return;
                }

                while (activeCount < CONCURRENCY_LIMIT && index < items.length) {
                    const item = items[index++];
                    activeCount++;

                    void (async () => {
                        try {
                            const content = await this.fetchItem(item.id);
                            const result = await ingestDocument(
                                content.type || "text",
                                content.data || content.text || "",
                                {
                                    metadata: { source: this.name, ...content.metadata },
                                    userId: this.userId,
                                },
                            );
                            successfulIds.push(result.rootMemoryId);
                        } catch (e: unknown) {
                            const err = e instanceof Error ? e : new Error(String(e));
                            logger.warn(
                                `[${this.name}] Failed to ingest ${item.id}: ${err.message}`,
                            );
                            errors.push({ id: item.id, error: err.message });
                        } finally {
                            activeCount--;
                            void next();
                        }
                    })();
                }
            };

            void next();
        });
    }

    protected _getEnv(key: string, default_val?: string): string | undefined {
        return Bun.env[key] || default_val;
    }

    // abstract methods for subclasses
    protected abstract _connect(creds: TCreds): Promise<boolean>;
    protected abstract _listItems(filters: TFilters): Promise<SourceItem[]>;
    protected abstract _fetchItem(itemId: string): Promise<SourceContent>;
}
