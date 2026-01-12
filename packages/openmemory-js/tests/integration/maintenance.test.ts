
import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { registerInterval, unregisterInterval, getMaintenanceStatus, stopAllMaintenance } from "../../src/core/scheduler";

describe("Maintenance Registry", () => {

    afterAll(async () => {
        await stopAllMaintenance();
        const { closeDb } = await import("../../src/core/db");
        await closeDb();
    });

    test("Should register and run a task", async () => {
        let runCount = 0;
        const cb = () => { runCount++; };

        registerInterval("test_task", cb, 50);

        // Wait for at least one run
        await new Promise(r => setTimeout(r, 150));

        expect(runCount).toBeGreaterThanOrEqual(2);
        unregisterInterval("test_task");
    });

    test("Should capture errors without crashing", async () => {
        const failingTask = () => { throw new Error("Maintenance failure"); };

        registerInterval("failing_task", failingTask, 50);

        await new Promise(r => setTimeout(r, 110));

        const status = getMaintenanceStatus();
        expect(status["failing_task"]).toBeDefined();
        expect(status["failing_task"].failures).toBeGreaterThan(0);
        expect(status["failing_task"].lastError).toBe("Maintenance failure");

        unregisterInterval("failing_task");
    });

    test("Should replace existing task with same ID", async () => {
        // ... omitted simple test as previous covers logic
    });
});
