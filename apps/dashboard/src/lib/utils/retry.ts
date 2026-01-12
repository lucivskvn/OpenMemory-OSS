
export interface RetryOptions {
    retries?: number;
    delay?: number;
    backoff?: number;
    shouldRetry?: (error: unknown) => boolean;
}

/**
 * Retries a function with exponential backoff.
 */
export async function retry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const retries = options.retries ?? 3;
    const delay = options.delay ?? 1000;
    const backoff = options.backoff ?? 2;
    const shouldRetry = options.shouldRetry ?? (() => true);

    let lastError: unknown;
    let currentDelay = delay;

    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (i === retries || !shouldRetry(err)) {
                throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, currentDelay));
            currentDelay *= backoff;
        }
    }

    throw lastError;
}
