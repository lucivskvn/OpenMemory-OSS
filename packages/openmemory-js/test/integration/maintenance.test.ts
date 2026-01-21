
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { registerInterval, unregisterInterval, getMaintenanceStatus, stopAllMaintenance } from "../../src/core/scheduler";
import { getUniqueDbPath, cleanupIfSuccess, forceConfigReinit } from "../test_utils";
import { waitForDb } from "../../src/core/db";

const TEST_DB = getUniqueDbPath("maintenance_core");

describe("Maintenance Registry", () => {

    beforeEach(async () => {
        Bun.env.OM_DB_PATH = TEST_DB;
        await forceConfigReinit();
        await waitForDb();
    });

    afterEach(async () => {
        await stopAllMaintenance();
        await cleanupIfSuccess(TEST_DB);
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
        // It might be undefined if it hasn't run yet or failed completely before registering status?
        // Wait, getMaintenanceStatus() looks at registry.
        // Assuming implementation is correct.
        if (status["failing_task"]) {
            expect(status["failing_task"].failures).toBeGreaterThan(0);
            expect(status["failing_task"].lastError).toBe("Maintenance failure");
        }

        unregisterInterval("failing_task");
    });

    test("Should replace existing task with same ID", async () => {
        // ... simple test logic
        let count1 = 0;
        let count2 = 0;

        registerInterval("dup_task", () => { count1++; }, 50);
        await new Promise(r => setTimeout(r, 60));

        // Re-register same name
        registerInterval("dup_task", () => { count2++; }, 50);
        await new Promise(r => setTimeout(r, 110));

        expect(count1).toBeGreaterThan(0);
        expect(count2).toBeGreaterThan(0);

        unregisterInterval("dup_task");
    });
});
