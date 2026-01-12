
import { describe, expect, test, mock, spyOn } from "bun:test";
import { registerInterval, unregisterInterval, getSchedulerStats, stopAllMaintenance } from "../../src/core/scheduler";
import { sleep } from "../../src/utils";

describe("Scheduler", () => {
    test("should execute task and track stats", async () => {
        const id = "test-task-" + Date.now();
        let ran = false;

        registerInterval(id, async () => {
            ran = true;
        }, 100);

        await sleep(200); // extensive wait for jitter + run
        const stats = getSchedulerStats()[id];

        expect(ran).toBe(true);
        expect(stats).toBeDefined();
        expect(stats.totalRuns).toBeGreaterThan(0);

        unregisterInterval(id);
    });

    test("should abort long running task on timeout", async () => {
        const id = "timeout-task-" + Date.now();
        let aborted = false;

        registerInterval(id, async (signal) => {
            // Simulate long work
            try {
                await new Promise((resolve, reject) => {
                    const t = setTimeout(resolve, 500);
                    if (signal) {
                        signal.addEventListener("abort", () => {
                            clearTimeout(t);
                            aborted = true;
                            reject(signal.reason);
                        });
                    }
                });
            } catch (e) {
                // Expected abort
                throw e;
            }
        }, 100, { timeoutMs: 50 }); // timeout < duration

        await sleep(300);

        const stats = getSchedulerStats()[id];
        expect(stats.failures).toBeGreaterThan(0);
        expect(aborted).toBe(true);
        expect(stats.lastError).toContain("timeout");

        unregisterInterval(id);
    });
});
