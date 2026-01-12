
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { app, stopServer } from "../packages/openmemory-js/src/server/index";
import { MemoryClient } from "../packages/openmemory-js/src/client";
import { env } from "../packages/openmemory-js/src/core/cfg";
import { closeDb } from "../packages/openmemory-js/src/core/db";
import * as fs from "fs";
import * as path from "path";

// Setup test environment
const TEST_DB = path.resolve("./test-sdk.db");
env.dbPath = TEST_DB;
env.port = 0; // Random port
env.verbose = false;

describe("Client SDK Verification", () => {
    let server: any;
    let client: MemoryClient;
    let baseUrl: string;

    beforeAll(async () => {
        if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

        // App is singleton from index.ts with routes already registered
        return new Promise<void>((resolve) => {
            server = app.listen(0, () => {
                const port = server.port;
                baseUrl = `http://localhost:${port}`;
                console.log(`Test server running at ${baseUrl}`);
                client = new MemoryClient({ baseUrl, defaultUser: "sdk-verifier" });
                resolve();
            });
        });
    });

    afterAll(async () => {
        if (server) {
            server.stop();
            stopServer();
        }
        await closeDb();
        if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    });

    it("should check health", async () => {
        const healthy = await client.health();
        expect(healthy).toBe(true);
    });

    it("should add and retrieve a memory", async () => {
        const mem = await client.add("Testing SDK synchronization", { tags: ["test", "sdk"] });
        expect(mem).toBeDefined();
        expect(mem.content).toBe("Testing SDK synchronization");

        const retrieved = await client.get(mem.id);
        expect(retrieved).toBeDefined();
        expect(retrieved?.id).toBe(mem.id);
    });

    it("should compress text via new API", async () => {
        const text = "This is a long text that should be compressed by the server logic to something smaller.";
        const result = await client.compress(text, "syntactic");
        expect(result).toBeDefined();
        expect(result.og).toBe(text);
        expect(result.comp).toBeDefined();
    });

    it("should get compression stats", async () => {
        const stats = await client.getCompressionStats();
        expect(stats).toBeDefined();
        expect(typeof stats.total).toBe("number");
    });

    it("should get dashboard stats", async () => {
        const stats = await client.getStats();
        expect(stats).toBeDefined();
        expect(stats?.totalMemories).toBeGreaterThanOrEqual(1);
    });

    it("should handle temporal facts", async () => {
        const fact = await client.addFact({
            subject: "SDK",
            predicate: "verifies",
            object: "Server"
        });
        expect(fact).toBeDefined();
        expect(fact.id).toBeDefined();

        const fetched = await client.getFacts({ subject: "SDK" });
        expect(fetched.length).toBeGreaterThan(0);
        expect(fetched[0].object).toBe("Server");
    });
});
