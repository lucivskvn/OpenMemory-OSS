import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTokenManager } from "../../src/server/setupToken";
import { TestWatchdog } from "../../src/utils/testWatchdog";

describe("CLI E2E Tests", () => {
    const dbPath = `.test_cli_e2e_${Date.now()}.db`;
    const absDbPath = require("path").resolve(dbPath);
    const shmPath = absDbPath + "-shm";
    const walPath = absDbPath + "-wal";

    const runCli = async (args: string[], signal?: AbortSignal) => {
        const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
            cwd: process.cwd(),
            env: { ...process.env, OM_DB_PATH: absDbPath, NODE_ENV: 'test' },
            stdout: "pipe",
            stderr: "pipe"
        });
        
        // Monitor the spawned process with watchdog
        TestWatchdog.monitorSpawnedProcess(proc, 30000, `CLI ${args.join(' ')}`);
        
        // Handle abort signal
        if (signal) {
            const abortHandler = () => {
                proc.kill();
            };
            signal.addEventListener('abort', abortHandler);
            
            // Clean up listener when process completes
            proc.exited.finally(() => {
                signal.removeEventListener('abort', abortHandler);
            });
        }
        
        const text = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        await proc.exited;
        
        return { text, err, exitCode: proc.exitCode };
    };

    afterAll(async () => {
        // Use Bun-native file deletion for cross-platform compatibility
        const platform = process.platform;
        const deleteCmd = platform === 'win32' ? 'del' : 'rm';
        const deleteArgs = platform === 'win32' ? ['/f', '/q'] : ['-f'];
        
        try {
            if (await Bun.file(absDbPath).exists()) {
                await Bun.spawn([deleteCmd, ...deleteArgs, absDbPath]);
            }
        } catch { }
        try {
            if (await Bun.file(shmPath).exists()) {
                await Bun.spawn([deleteCmd, ...deleteArgs, shmPath]);
            }
        } catch { }
        try {
            if (await Bun.file(walPath).exists()) {
                await Bun.spawn([deleteCmd, ...deleteArgs, walPath]);
            }
        } catch { }
    });



    test("CLI E2E Sequential Flow", async () => {
        const result = await TestWatchdog.withE2ETimeout(async (signal) => {
            // Helper to extract JSON from mixed output - simplistic matching
            const extractJson = (text: string) => {
                // Allow for multiple json blocks, take the last one that looks like an object
                // or just try to clean up the output
                console.log("Parsing Output:", text);
                try {
                    // Try parsing the whole thing first
                    return JSON.parse(text.trim());
                } catch (e) {
                    // Try finding the first '{' and last '}'
                    const firstOpen = text.indexOf('{');
                    const lastClose = text.lastIndexOf('}');
                    if (firstOpen >= 0 && lastClose > firstOpen) {
                        const candidate = text.substring(firstOpen, lastClose + 1);
                        try { return JSON.parse(candidate); } catch (e2) { }
                    }
                    throw new Error(`Failed to extract JSON from: ${text.substring(0, 100)}...`);
                }
            };

            // 1. Doctor
            console.log("Running Doctor...");
            const doctorRes = await runCli(["doctor"], signal);
            console.log("Doctor Output:", doctorRes.text);
            console.log("Doctor Error:", doctorRes.err);
            console.log("Doctor Exit Code:", doctorRes.exitCode);
            expect(doctorRes.exitCode).toBe(0);
            expect(doctorRes.text).toContain("stats:");

            // 2. Add
            console.log("Running Add...");
            const addRes = await runCli(["add", "Hello World from CLI", "--user-id", "cli-user", "--tags", "test,cli"], signal);
            console.log("Add Output:", addRes.text);
            console.log("Add Error:", addRes.err);
            console.log("Add Exit Code:", addRes.exitCode);
            expect(addRes.exitCode).toBe(0);
            const added = extractJson(addRes.text);
            expect(added.id).toBeDefined();
            expect(added.content).toBe("Hello World from CLI");
            const id = added.id;

            // 3. Search
            console.log("Running Search...");
            const searchRes = await runCli(["search", "Hello", "--user-id", "cli-user"], signal);
            expect(searchRes.exitCode).toBe(0);
            expect(searchRes.text).toContain("Hello World from CLI");
            // Search output in CLI is formatted text by default unless it's raw JSON?
            // In src/cli/commands/core.ts, it prints formatted text for search unless it fails.
            // matches: "1. [sector] content..."

            // 4. Update
            console.log("Running Update...");
            const updateRes = await runCli(["update", id, "Updated Content", "--user-id", "cli-user"], signal);
            console.log("Update Output:", updateRes.text);
            console.log("Update Error:", updateRes.err);
            console.log("Update Exit Code:", updateRes.exitCode);
            expect(updateRes.exitCode).toBe(0);
            const updated = extractJson(updateRes.text);
            expect(updated.content).toBe("Updated Content");

            // 5. Stats
            console.log("Running Stats...");
            const statsRes = await runCli(["stats", "--user-id", "cli-user"], signal);
            expect(statsRes.exitCode).toBe(0);
            console.log("Stats Output:", statsRes.text);
            const stats = extractJson(statsRes.text);
            expect(stats.memories).toBeGreaterThan(0);

            // 6. Delete
            console.log("Running Delete...");
            const delRes = await runCli(["delete", id, "--user-id", "cli-user"], signal);
            console.log("Delete Output:", delRes.text);
            console.log("Delete Error:", delRes.err);
            console.log("Delete Exit Code:", delRes.exitCode);
            expect(delRes.exitCode).toBe(0);
            const deleted = extractJson(delRes.text);
            expect(deleted.success).toBe(true);
            expect(deleted.id).toBe(id);

            return "success";
        }, { 
            testName: "CLI E2E Sequential Flow",
            killProcess: false // Don't kill the entire test process, just fail the test
        });

        expect(result.timedOut).toBe(false);
        expect(result.result).toBe("success");
    }, 180000); // 3 minute timeout for the entire test

});
