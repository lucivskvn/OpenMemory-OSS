
import { describe, test, expect, mock, beforeAll } from "bun:test";
import { CircuitBreaker, CircuitState, withResilience, retry } from "../../src/utils/retry";

describe("Resilience Utilities", () => {

    describe("Retry", () => {
        test("Should succeed immediately if no error", async () => {
            const fn = mock(() => Promise.resolve("ok"));
            const result = await retry(fn);
            expect(result).toBe("ok");
            expect(fn).toHaveBeenCalledTimes(1);
        });

        test("Should retry on failure and eventually succeed", async () => {
            let calls = 0;
            const fn = () => {
                calls++;
                if (calls < 3) return Promise.reject(new Error("fail"));
                return Promise.resolve("ok");
            };

            const result = await retry(fn, { retries: 3, delay: 10 });
            expect(result).toBe("ok");
            expect(calls).toBe(3);
        });

        test("Should fail after max retries", async () => {
            const fn = mock(() => Promise.reject(new Error("fail")));

            try {
                await retry(fn, { retries: 2, delay: 10 });
            } catch (e: any) {
                expect(e.message).toBe("fail");
            }
            expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
        });
    });

    describe("CircuitBreaker", () => {
        test("Should fail fast when OPEN", async () => {
            const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 100 });
            const fn = mock(() => Promise.reject(new Error("fail")));

            // 1. Failures to open circuit
            try { await breaker.execute(fn); } catch { }
            try { await breaker.execute(fn); } catch { }

            expect(breaker.state).toBe(CircuitState.OPEN);

            // 2. Fail fast
            const start = Date.now();
            try {
                await breaker.execute(fn);
            } catch (e: any) {
                expect(e.message).toContain("Circuit OPEN");
            }
            expect(fn).toHaveBeenCalledTimes(2); // Should NOT call fn again
        });

        test("Should transition to HALF_OPEN and recover", async () => {
            const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 50 });
            const failFn = () => Promise.reject(new Error("fail"));
            const successFn = () => Promise.resolve("recovery");

            // Open it
            try { await breaker.execute(failFn); } catch { }
            expect(breaker.state).toBe(CircuitState.OPEN);

            // Wait for reset timeout
            await new Promise(r => setTimeout(r, 60));

            // Should be HALF_OPEN logic (allow 1 call)
            const result = await breaker.execute(successFn);
            expect(result).toBe("recovery");
            expect(breaker.state).toBe(CircuitState.CLOSED);
        });
    });
});
