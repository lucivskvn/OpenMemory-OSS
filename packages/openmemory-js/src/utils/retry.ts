import { logger } from "./logger";

export interface RetryOptions {
    retries?: number;
    decay?: number; // exponential factor
    delay?: number; // base delay in ms
    onRetry?: (err: unknown, attempt: number) => void;
    shouldRetry?: (err: unknown) => boolean;
}

/**
 * Sleep for a specified duration.
 * @param ms - Milliseconds to sleep.
 */
export const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Standard retry utility with exponential backoff and jitter.
 *
 * @param fn - The async operation to retry.
 * @param options - Configuration for retries (count, decay, delay).
 * @returns The result of the operation.
 */
export const retry = async <T>(
    fn: () => Promise<T>,
    options: RetryOptions = {},
): Promise<T> => {
    const retries = options.retries ?? 3;
    const decay = options.decay ?? 2;
    const delay = options.delay ?? 1000;
    const jitter = 0.1; // 10% jitter
    const startTime = Date.now();
    const maxTimeout = 60000; // 60s default max total time often useful, but let's keep it optional in interface later if needed, for now just logic

    for (let i = 0; i <= retries; i++) {
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
                baseMs * (1 + (Math.random() * jitter * 2 - jitter)); // +/- 10%
            await sleep(jitterMs);
        }
    }
    throw new Error("Unreachable");
};

export enum CircuitState {
    CLOSED = "CLOSED", // Normal operation
    OPEN = "OPEN", // Failing, request blocked
    HALF_OPEN = "HALF_OPEN", // Testing recovery
}

export interface CircuitBreakerOptions {
    failureThreshold?: number; // Number of failures to open circuit
    resetTimeout?: number; // Time in ms to wait before trying again (HALF_OPEN)
    name?: string;
}

/**
 * Circuit Breaker implementation to prevent cascading failures.
 */
export class CircuitBreaker {
    state: CircuitState = CircuitState.CLOSED;
    private failures = 0;
    private lastFailureTime = 0;
    private readonly failureThreshold: number;
    private readonly resetTimeout: number;
    private readonly name: string;

    constructor(options: CircuitBreakerOptions = {}) {
        this.failureThreshold = options.failureThreshold ?? 5;
        this.resetTimeout = options.resetTimeout ?? 60000;
        this.name = options.name ?? "CircuitBreaker";
    }

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === CircuitState.OPEN) {
            if (Date.now() - this.lastFailureTime > this.resetTimeout) {
                this.state = CircuitState.HALF_OPEN;
                logger.info(
                    `[${this.name}] Circuit HALF_OPEN: Probing service...`,
                );
            } else {
                throw new Error(
                    `[${this.name}] Circuit OPEN: Request blocked.`,
                );
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
        this.state = CircuitState.CLOSED;
    }

    private onFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();

        if (
            this.state === CircuitState.HALF_OPEN ||
            this.failures >= this.failureThreshold
        ) {
            this.state = CircuitState.OPEN;
            logger.error(
                `[${this.name}] Circuit OPENED after ${this.failures} failures.`,
            );
        }
    }
}

/**
 * Higher-order function combining Retry and Circuit Breaker.
 * Circuit Breaker wraps the Retry logic (failures in retry contribute to breaking).
 */
export async function withResilience<T>(
    fn: () => Promise<T>,
    breaker: CircuitBreaker,
    retryOpts?: RetryOptions,
): Promise<T> {
    return breaker.execute(() => retry(fn, retryOpts));
}
