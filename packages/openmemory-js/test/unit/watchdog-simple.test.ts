/**
 * @file Simple Watchdog Test
 * Tests basic watchdog functionality without timeout scenarios
 */

import { describe, test, expect } from "bun:test";
import { runWithWatchdog, registerTestExecution, unregisterTestExecution } from "../../src/utils/testWatchdog";

describe("Simple Watchdog Tests", () => {
    test("should complete fast test", async () => {
        const result = await runWithWatchdog(
            "fast-test",
            async () => {
                return "completed";
            },
            5000 // 5 second timeout
        );

        expect(result).toBe("completed");
    });

    test("should handle registration", () => {
        const executionId = registerTestExecution("simple-test", 10000);
        expect(executionId).toBeDefined();
        unregisterTestExecution(executionId);
    });
});