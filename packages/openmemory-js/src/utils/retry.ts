import { logger } from "./logger";

export interface RetryOptions {
    /** Maximum number of retry attempts. Default: 3 */
    retries?: number;
    /** Exponential backoff factor. Default: 2 */
    decay?: number;
    /** Base delay in milliseconds. Default: 1000 */
    delay?: number;
    /** Maximum total timeout in milliseconds. Default: 60000 (60s) */
    maxTimeout?: number;
    /** Callback invoked on each retry attempt */
    onRetry?: (err: unknown, attempt: number) => void;
    /** Predicate to determine if error is retryable. Default: retry all errors */
    shouldRetry?: (err: unknown) => boolean;
    /** AbortSignal to cancel retries */
    signal?: AbortSignal;
}

/**
 * Sleep for a specified duration with AbortSignal support.
 * @param ms - Milliseconds to sleep.
 * @param signal - Optional AbortSignal to cancel sleep.
 */
export const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("Aborted"));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
        }, { once: true });
    });

/**
 * Standard retry utility with exponential backoff and jitter.
 */
export const retry = async <T>(
    fn: () => Promise<T>,
    options: RetryOptions = {},
): Promise<T> => {
    const retries = options.retries ?? 3;
    const decay = options.decay ?? 2;
    const delay = options.delay ?? 1000;
    const maxTimeout = options.maxTimeout ?? 60000;
    const jitter = 0.1;
    const startTime = Date.now();

    for (let i = 0; i <= retries; i++) {
        if (options.signal?.aborted) throw new Error("Aborted");

        try {
            return await fn();
        } catch (err: unknown) {
            if (options.shouldRetry && !options.shouldRetry(err)) throw err;
            if (i === retries) throw err;

            if (options.onRetry) options.onRetry(err, i + 1);
            else
                logger.warn(`[Retry] Attempt ${i + 1}/${retries} failed:`, {
                    error: err,
                });

            if (Date.now() - startTime > maxTimeout) {
                throw new Error("Retry timeout exceeded");
            }

            const baseMs = delay * Math.pow(decay, i);
            const jitterMs =
                baseMs * (1 + (Math.random() * jitter * 2 - jitter));

            try {
                await sleep(jitterMs, options.signal);
            } catch (e) {
                if (options.signal?.aborted) throw e;
                throw e;
            }
        }
    }
    throw new Error("Unreachable");
};

export enum CircuitState {
    CLOSED = "CLOSED",
    OPEN = "OPEN",
    HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerOptions {
    failureThreshold?: number;
    resetTimeout?: number;
    name?: string;
    onStateChange?: (state: CircuitState, name: string) => void;
}

/**
 * Circuit Breaker implementation for SDK resilience.
 */
export class CircuitBreaker {
    private _state: CircuitState = CircuitState.CLOSED;
    private failures = 0;
    private lastFailureTime = 0;
    private readonly failureThreshold: number;
    private readonly resetTimeout: number;
    private readonly name: string;
    private readonly onStateChange?: (state: CircuitState, name: string) => void;

    get state(): CircuitState {
        return this._state;
    }

    constructor(options: CircuitBreakerOptions = {}) {
        this.failureThreshold = options.failureThreshold ?? 5;
        this.resetTimeout = options.resetTimeout ?? 60000;
        this.name = options.name ?? "CircuitBreaker";
        this.onStateChange = options.onStateChange;
    }

    private setState(state: CircuitState) {
        if (this._state !== state) {
            this._state = state;
            this.onStateChange?.(state, this.name);
        }
    }

    async execute<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) throw new Error("Aborted");

        if (this.state === CircuitState.OPEN) {
            if (Date.now() - this.lastFailureTime > this.resetTimeout) {
                this.setState(CircuitState.HALF_OPEN);
                logger.info(`[${this.name}] Circuit HALF_OPEN: Probing...`);
            } else {
                throw new Error(`[${this.name}] Circuit OPEN: Request blocked.`);
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (err) {
            this.onFailure();
            throw err;
        }
    }

    private onSuccess() {
        if (this.state === CircuitState.HALF_OPEN) {
            logger.info(`[${this.name}] Circuit CLOSED: Service recovered.`);
        }
        this.failures = 0;
        this.setState(CircuitState.CLOSED);
    }

    private onFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();

        if (this.state === CircuitState.HALF_OPEN || this.failures >= this.failureThreshold) {
            this.setState(CircuitState.OPEN);
            logger.error(`[${this.name}] Circuit OPENED after ${this.failures} failures.`);
        }
    }
}

/**
 * Higher-order function combining Retry and Circuit Breaker with AbortSignal support.
 */
export async function withResilience<T>(
    fn: () => Promise<T>,
    breaker: CircuitBreaker,
    retryOpts?: RetryOptions,
): Promise<T> {
    return breaker.execute(() => retry(fn, retryOpts), retryOpts?.signal);
}
