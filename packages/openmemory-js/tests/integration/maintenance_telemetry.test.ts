import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { registerInterval, unregisterInterval, stopAllMaintenance, getRunningIntervals, getMaintenanceStatus } from "../../src/core/scheduler";
import { retry, CircuitBreaker } from "../../src/utils/retry";
import { logger } from "../../src/utils/logger";

// Mock Logger to prevent spam
mock.module("../../src/utils/logger", () => ({
    logger: {
        info: mock(() => { }),
        error: mock(() => { }),
        warn: mock(() => { }),
    }
}));

describe("Core: Maintenance", () => {
    afterEach(async () => {
        await stopAllMaintenance();
    });

    test("registerInterval starts a task", async () => {
        let runCount = 0;
        const cb = async () => { runCount++; };
        const id = registerInterval("test-task", cb, 50);

        expect(getRunningIntervals()).toContain(id);

        await new Promise(r => setTimeout(r, 120)); // wait for ~2 runs
        expect(runCount).toBeGreaterThan(0);

        unregisterInterval(id);
        expect(getRunningIntervals()).not.toContain(id);
    });

    test("maintenance handles errors gracefully", async () => {
        const id = registerInterval("fail-task", async () => { throw new Error("Boom"); }, 50);

        await new Promise(r => setTimeout(r, 120)); // wait for runs

        const status = getMaintenanceStatus();
        expect(status[id]).toBeDefined();
        expect(status[id].failures).toBeGreaterThan(0);
        expect(status[id].lastError).toBe("Boom");
    });
});

describe("Utils: Retry", () => {
    test("retry succeeds eventually", async () => {
        let att = 0;
        const res = await retry(async () => {
            att++;
            if (att < 2) throw new Error("Fail");
            return "Success";
        }, { retries: 3, delay: 10 });

        expect(res).toBe("Success");
        expect(att).toBe(2);
    });

    test("retry fails after max attempts", async () => {
        try {
            await retry(async () => { throw new Error("Always Fail"); }, { retries: 2, delay: 10 });
            expect.unreachable();
        } catch (e: unknown) {
            expect(String(e)).toContain("Always Fail");
        }
    });
});
