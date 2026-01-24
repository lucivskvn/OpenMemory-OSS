/**
 * @file Process Management Integration Test
 * Tests the robust process management system for test execution
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { testProcessManager, runTestCommand } from "../../src/utils/testProcessManager";
import { testServerManager, startOpenMemoryServer } from "../../src/utils/testServer";
import { createTestSuiteTimeout, runTestWithTimeout } from "../../src/utils/testTimeout";
import { 
    createProcessTestSuite, 
    createProcessTest, 
    runTestCommandSafe,
    waitForCondition,
    findAvailablePort,
    createTestEnvironment
} from "../helpers/processTestHelper";

describe("Process Management System", () => {
    let suiteTimeout: ReturnType<typeof createTestSuiteTimeout>;

    beforeAll(async () => {
        suiteTimeout = createTestSuiteTimeout("Process Management", 60000);
    });

    afterAll(async () => {
        suiteTimeout.cancel();
        await testProcessManager.stopAllProcesses();
        await testServerManager.stopAllServers();
    });

    test("should manage test processes with timeout", async () => {
        const processId = "test-echo-process";
        
        // Test successful command
        const result = await runTestCommand(
            processId,
            ["echo", "Hello World"],
            { timeout: 5000 }
        );

        expect(result.success).toBe(true);
        expect(result.output).toContain("Hello World");
        expect(testProcessManager.isProcessRunning(processId)).toBe(false);
    });

    test("should handle process timeout correctly", async () => {
        const processId = "test-timeout-process";
        
        // Test command that should timeout (sleep for longer than timeout)
        const result = await runTestCommand(
            processId,
            process.platform === 'win32' 
                ? ["powershell", "-Command", "Start-Sleep -Seconds 10"]
                : ["sleep", "10"],
            { 
                timeout: 2000, // 2 second timeout
                killOnTimeout: true 
            }
        );

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(testProcessManager.isProcessRunning(processId)).toBe(false);
    });

    test("should start and stop test server", async () => {
        const port = await findAvailablePort(3100);
        
        // Start server
        const serverProcess = await startOpenMemoryServer(port, {
            id: "test-server-process",
            startupTimeout: 15000
        });

        expect(serverProcess.status).toBe("running");
        expect(testServerManager.isServerRunning("test-server-process")).toBe(true);

        // Wait for server to be ready
        await waitForCondition(async () => {
            try {
                const response = await fetch(`http://localhost:${port}/health`);
                return response.ok;
            } catch {
                return false;
            }
        }, 10000);

        // Make a test request
        const response = await testServerManager.makeRequest(
            "test-server-process",
            "/health"
        );
        expect(response.ok).toBe(true);

        // Stop server
        const stopped = await testServerManager.stopServer("test-server-process");
        expect(stopped).toBe(true);
        expect(testServerManager.isServerRunning("test-server-process")).toBe(false);
    });

    test("should handle graceful shutdown", async () => {
        const processId = "test-graceful-shutdown";
        
        // Start a long-running process
        const processInfo = await testProcessManager.startProcess({
            id: processId,
            command: process.platform === 'win32'
                ? ["powershell", "-Command", "while($true) { Start-Sleep -Seconds 1 }"]
                : ["bash", "-c", "while true; do sleep 1; done"],
            timeout: 30000
        });

        expect(processInfo.status).toBe("running");
        expect(testProcessManager.isProcessRunning(processId)).toBe(true);

        // Stop the process gracefully
        const stopped = await testProcessManager.stopProcess(processId, 5000);
        expect(stopped).toBe(true);
        expect(testProcessManager.isProcessRunning(processId)).toBe(false);
    });

    test("should clean up orphaned processes", async () => {
        // This test verifies that the orphaned process monitor works
        const processId = "test-orphan-cleanup";
        
        // Start a process that will become orphaned
        await testProcessManager.startProcess({
            id: processId,
            command: ["echo", "test"],
            timeout: 1000
        });

        // Wait for process to complete naturally
        await new Promise(resolve => setTimeout(resolve, 2000));

        // The process should be automatically cleaned up
        expect(testProcessManager.isProcessRunning(processId)).toBe(false);
    });

    test("should handle multiple concurrent processes", async () => {
        const processes = [];
        const numProcesses = 5;

        // Start multiple processes concurrently
        for (let i = 0; i < numProcesses; i++) {
            const processId = `concurrent-process-${i}`;
            processes.push(
                testProcessManager.startProcess({
                    id: processId,
                    command: ["echo", `Process ${i}`],
                    timeout: 10000
                })
            );
        }

        // Wait for all processes to start
        const processInfos = await Promise.all(processes);
        expect(processInfos).toHaveLength(numProcesses);

        // All processes should be tracked
        const allProcesses = testProcessManager.getAllProcesses();
        expect(allProcesses.length).toBeGreaterThanOrEqual(numProcesses);

        // Wait for processes to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Stop any remaining processes
        await testProcessManager.stopAllProcesses();
        
        // All processes should be stopped
        const remainingProcesses = testProcessManager.getAllProcesses();
        expect(remainingProcesses.filter(p => p.status === 'running')).toHaveLength(0);
    });
});

// Example of using the helper functions
createProcessTestSuite({
    name: "Process Helper Integration",
    timeout: 30000,
    startServer: false, // Don't start server for this suite
    setup: async () => {
        // Custom setup logic
    },
    teardown: async () => {
        // Custom teardown logic
    }
}, () => {
    createProcessTest({
        name: "should run command safely",
        timeout: 10000,
        cleanupFiles: true
    }, async () => {
        const result = await runTestCommandSafe(
            "safe-command-test",
            ["echo", "Safe command execution"],
            { expectSuccess: true }
        );

        expect(result.success).toBe(true);
        expect(result.output).toContain("Safe command execution");
    });

    createProcessTest({
        name: "should handle test environment",
        timeout: 5000
    }, async () => {
        const env = createTestEnvironment("environment-test");
        
        expect(env.OM_TEST_MODE).toBe("true");
        expect(env.OM_TIER).toBe("local");
        expect(env.OM_TEST_NAME).toBe("environment-test");
    });
});