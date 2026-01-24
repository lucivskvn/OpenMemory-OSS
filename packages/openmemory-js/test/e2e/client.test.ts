
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { MemoryClient } from "../../src/client";

// E2E Test covering Client SDK against a real running server
// We will spawn the server in a separate process
describe("Client E2E & CLI Parity", () => {
    let serverProc: Bun.Subprocess;
    let client: MemoryClient;
    const PORT = 3456;
    const HOST = `http://localhost:${PORT}`;

    beforeAll(async () => {
        // Start Server
        // using Bun.spawn to run src/server/start.ts
        serverProc = Bun.spawn(["bun", "src/server/start.ts"], {
            env: { ...process.env, PORT: PORT.toString(), OM_DB_PATH: ":memory:", OM_VERBOSE: "true", OM_API_KEY: "test-key" },
            stdio: ["pipe", "pipe", "pipe"]
        });

        // Wait for server to be ready
        let booted = false;
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Server timeout. Logs:\n" + serverLogs.join("\n"))), 30000);

            const serverLogs: string[] = [];

            // Read stdout using Bun's ReadableStream
            if (serverProc.stdout) {
                const reader = serverProc.stdout.getReader();
                const decoder = new TextDecoder();
                
                const readOutput = async () => {
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            
                            const str = decoder.decode(value);
                            serverLogs.push(`[STDOUT] ${str}`);
                            console.log(`[SERVER] ${str}`); // Pipe to test output
                            if (str.includes(`Running on http://localhost:${PORT}`)) {
                                booted = true;
                                clearTimeout(timeout);
                                resolve();
                                return;
                            }
                        }
                    } catch (e) {
                        console.error(`[SERVER_OUT] ${e}`);
                    }
                };
                readOutput();
            }

            // Read stderr using Bun's ReadableStream
            if (serverProc.stderr) {
                const reader = serverProc.stderr.getReader();
                const decoder = new TextDecoder();
                
                const readError = async () => {
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            
                            const str = decoder.decode(value);
                            serverLogs.push(`[STDERR] ${str}`);
                            console.error(`[SERVER_ERR] ${str}`);
                        }
                    } catch (e) {
                        console.error(`[SERVER_ERR] ${e}`);
                    }
                };
                readError();
            }

            // Handle process exit
            serverProc.exited.then((code) => {
                if (!booted) {
                    reject(new Error(`Server exited prematurely with code ${code}. Logs:\n${serverLogs.join("\n")}`));
                }
            });
        });

        client = new MemoryClient({ baseUrl: HOST, token: "test-key" });
    }, 30000);

    afterAll(() => {
        if (serverProc) serverProc.kill();
    });

    test("Health Check", async () => {
        const ok = await client.health();
        expect(ok).toBe(true);
    });

    test("Add & Retrieve Memory", async () => {
        const mem = await client.add("Hello World E2E", { tags: ["e2e"] });
        expect(mem.id).toBeDefined();

        const retrieved = await client.get(mem.id);
        expect(retrieved).toBeDefined();
        expect(retrieved?.content).toBe("Hello World E2E");
    });

    test("Search Memory", async () => {
        await client.add("Another memory for search", { userId: "user-1" });
        // wait a bit for async indexing if any (sqlite usually immediate for small)
        await new Promise(r => setTimeout(r, 100));

        const results = await client.search("search", { userId: "user-1" });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].content).toContain("search");
    });

    test("Stats Consistency", async () => {
        const stats = await client.getStats();
        expect(stats).not.toBeNull();
        expect(stats?.counts?.memories).toBeGreaterThanOrEqual(2);
    });

    test("Temporal Graph - Remote", async () => {
        const f = await client.addFact({
            subject: "E2E_Test",
            predicate: "is_running",
            object: "true"
        });
        expect(f.id).toBeDefined();

        const facts = await client.searchFacts("E2E_Test");
        expect(facts.length).toBeGreaterThan(0);
        expect(facts[0].subject).toBe("E2E_Test");
    });
});
