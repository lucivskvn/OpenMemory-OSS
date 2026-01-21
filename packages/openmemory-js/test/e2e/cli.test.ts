import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTokenManager } from "../../src/server/setup_token";
import { unlinkSync, existsSync } from "fs";
import { resolve } from "path";

describe("CLI E2E Tests", () => {
    const dbPath = `.test_cli_e2e_${Date.now()}.db`;
    const absDbPath = resolve(dbPath);
    const shmPath = absDbPath + "-shm";
    const walPath = absDbPath + "-wal";

    const runCli = async (args: string[]) => {
        const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
            cwd: process.cwd(),
            env: { ...process.env, OM_DB_PATH: absDbPath, NODE_ENV: 'test' },
            stdout: "pipe",
            stderr: "pipe"
        });
        const text = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        await proc.exited;
        return { text, err, exitCode: proc.exitCode };
    };

    afterAll(() => {
        try { if (existsSync(absDbPath)) unlinkSync(absDbPath); } catch { }
        try { if (existsSync(shmPath)) unlinkSync(shmPath); } catch { }
        try { if (existsSync(walPath)) unlinkSync(walPath); } catch { }
    });



    test("CLI E2E Sequential Flow", async () => {
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
        const doctorRes = await runCli(["doctor"]);
        // console.log("Doctor Output:", doctorRes.text);
        expect(doctorRes.exitCode).toBe(0);
        expect(doctorRes.text).toContain("stats:");

        // 2. Add
        console.log("Running Add...");
        const addRes = await runCli(["add", "Hello World from CLI", "--user-id", "cli-user", "--tags", "test,cli"]);
        // console.log("Add Output:", addRes.text); 
        // We enabled logging inside extractJson
        expect(addRes.exitCode).toBe(0);
        const added = extractJson(addRes.text);
        expect(added.id).toBeDefined();
        expect(added.content).toBe("Hello World from CLI");
        const id = added.id;

        // 3. Search
        console.log("Running Search...");
        const searchRes = await runCli(["search", "Hello", "--user-id", "cli-user"]);
        expect(searchRes.exitCode).toBe(0);
        expect(searchRes.text).toContain("Hello World from CLI");
        // Search output in CLI is formatted text by default unless it's raw JSON?
        // In src/cli/commands/core.ts, it prints formatted text for search unless it fails.
        // matches: "1. [sector] content..."

        // 4. Update
        console.log("Running Update...");
        const updateRes = await runCli(["update", id, "Updated Content", "--user-id", "cli-user"]);
        expect(updateRes.exitCode).toBe(0);
        const updated = extractJson(updateRes.text);
        expect(updated.content).toBe("Updated Content");

        // 5. Stats
        console.log("Running Stats...");
        const statsRes = await runCli(["stats", "--user-id", "cli-user"]);
        expect(statsRes.exitCode).toBe(0);
        console.log("Stats Output:", statsRes.text);
        const stats = extractJson(statsRes.text);
        expect(stats.memories).toBeGreaterThan(0);

        // 6. Delete
        console.log("Running Delete...");
        const delRes = await runCli(["delete", id, "--user-id", "cli-user"]);
        expect(delRes.exitCode).toBe(0);
        const deleted = extractJson(delRes.text);
        expect(deleted.success).toBe(true);
        expect(deleted.id).toBe(id);

    }, 60000); // 60s timeout

});
