/**
 * @file Test Watchdog Unit Test
 * Tests the automatic test termination system
 */

import { describe, test, expect } from "bun:test";
import { runWithWatchdog, registerTestExecution, unregisterTestExecution } from "../../src/utils/testWatchdog";

describe("Test Watchdog", () => {
    test("should complete normal test within timeout", async () => {
        const result = await runWithWatchdog(
            "normal-test",
            async () => {
                // Simulate normal test work
                await new Promise(resolve => setTimeout(resolve, 100));
                return "success";
            },
            5000 // 5 second timeout
        );

        expect(result).toBe("success");
    });

    test("should handle test registration and unregistration", async () => {
        const executionId = registerTestExecution("test-registration", 10000);
        expect(executionId).toBeDefined();
        expect(typeof executionId).toBe("string");

        // Unregister the test
        unregisterTestExecution(executionId);
        
        // Should not throw
        expect(true).toBe(true);
    });

    test("should timeout stuck test (controlled)", async () => {
        let timeoutOccurred = false;
        
        try {
            await runWithWatchdog(
                "timeout-test",
                async () => {
                    // Simulate a stuck test that takes longer than timeout
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    return "should-not-reach";
                },
                1000 // 1 second timeout - shorter than the test duration
            );
        } catch (error) {
            timeoutOccurred = true;
            expect(error).toBeDefined();
        }

        // Note: This test might not always catch the timeout due to the aggressive
        // nature of the watchdog, but it demonstrates the concept
        expect(timeoutOccurred).toBe(true);
    });

    test("should handle errors in test functions", async () => {
        let errorCaught = false;
        
        try {
            await runWithWatchdog(
                "error-test",
                async () => {
                    throw new Error("Test error");
                },
                5000
            );
        } catch (error) {
            errorCaught = true;
            expect(error.message).toBe("Test error");
        }

        expect(errorCaught).toBe(true);
    });
});