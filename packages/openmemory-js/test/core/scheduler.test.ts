
import { describe, expect, test, mock, beforeEach, afterEach, jest } from "bun:test";
import { registerInterval, stopAllMaintenance, getSchedulerStats } from "../../src/core/scheduler";
import { DistributedLock } from "../../src/utils/lock";

// Mock DistributedLock
mock.module("../../src/utils/lock", () => {
    return {
        DistributedLock: class MockLock {
            resource: string;
            constructor(resource: string) {
                this.resource = resource;
            }
            async acquire(ttl: number) {
                return true;
            }
            async release() {
                return true;
            }
        }
    };
});

describe("Scheduler Core", () => {
    beforeEach(async () => {
        await stopAllMaintenance();
    });

    afterEach(async () => {
        await stopAllMaintenance();
        jest.restoreAllMocks();
    });

    test("should run a task periodically", async () => {
        const callback = jest.fn();
        // Use a short interval and 0 jitter for testing
        // Note: scheduler has built-in jitter logic we might need to bypass or wait for
        // We can force "isTest" in env, but accessing env module mocking might be complex.
        // The scheduler skips jitter if ms < 1000.

        const id = registerInterval("test-task", callback, 50);

        // Wait for enough time for multiple runs
        // Initial run (immediate or delayed) + intervals
        await new Promise(r => setTimeout(r, 150));

        expect(callback).toHaveBeenCalled();
        expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);

        const stats = getSchedulerStats();
        expect(stats["test-task"]).toBeDefined();
        expect(stats["test-task"].totalRuns).toBeGreaterThanOrEqual(1);
    });

    test("should respect async task duration", async () => {
        let executionCount = 0;
        const callback = async () => {
            executionCount++;
            await new Promise(r => setTimeout(r, 50)); // Task takes 50ms
        };

        registerInterval("async-task", callback, 20); // Interval 20ms (shorter than task)

        // Scheduler blindly uses setInterval, so it might overlap if not protected!
        // `executeTask` checks `if (stats.running) return;`
        // So it should SKIP runs if previous is still running.

        await new Promise(r => setTimeout(r, 200));

        // In 200ms:
        // Task takes 50ms.
        // It should run at T=0, finish T=50.
        // T=20 (skip), T=40 (skip).
        // T=60 (run), finish T=110.
        // T=80 (simul with 60? no), T=80 starts after 60? 
        // setInterval fires every 20ms. 
        // T=0: RUN. Stats.running = true.
        // T=20: Check running? True. Skip.
        // T=40: Check running? True. Skip.
        // T=50: Finish. running = false.
        // T=60: RUN.

        // Expected roughly 200/50 = 4 runs max, maybe less due to timing adjustment. 
        // Definitely NOT 200/20 = 10 runs.

        const stats = getSchedulerStats();
        // Just verify it didn't run 10 times
        expect(executionCount).toBeLessThan(8);
    });

    test("should handle timeouts correctly", async () => {
        const stats = getSchedulerStats();
        let errorCaught: Error | undefined;

        const callback = async (signal?: AbortSignal) => {
            await new Promise((resolve, reject) => {
                const t = setTimeout(resolve, 200); // 200ms task
                signal?.addEventListener('abort', () => {
                    clearTimeout(t);
                    reject(signal.reason);
                });
            });
        };

        // Timeout 50ms
        registerInterval("timeout-task", callback, 500, { timeoutMs: 50 });

        await new Promise(r => setTimeout(r, 100)); // Wait for execution and timeout

        const taskStats = getSchedulerStats()["timeout-task"];
        expect(taskStats.failures).toBeGreaterThan(0);
        expect(taskStats.lastError).toContain("Task timeout");
    });
});
