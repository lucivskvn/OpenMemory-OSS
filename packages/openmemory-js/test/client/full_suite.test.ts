import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";

// Force a specific test port to avoid collision
// const TEST_PORT = 31240; // Deprecated: Use random port 0
let BASE_URL = "";
const TEST_USER = "00000000-0000-0000-0000-000000000001"; // UUID-like to prevent NULL normalization

let server: any;
let stopServer: () => Promise<void>;
let stopAllMaintenance: any;
let closeDb: any;
let MemoryClient: any;
let AdminClient: any;
let dynamicApiKey: string;
let DB_PATH: string;
let originalFetch: typeof global.fetch;

describe("Client SDK Comprehensive Suite", () => {
    beforeAll(async () => {
        const path = await import("node:path");
        const fs = await import("node:fs");

        // Use import.meta.dir for consistent path resolution in Bun
        const testDataDir = path.join(import.meta.dir, "..", "data");
        DB_PATH = path.join(testDataDir, `test_client_suite_${Date.now()}.sqlite`);

        // 1. Set Environment Variables
        process.env.OM_PORT = "0";
        process.env.OM_VERBOSE = "false";
        process.env.OM_API_KEY = "system-client-suite-key";
        process.env.OM_ADMIN_KEY = "system-client-suite-key";
        process.env.OM_DB_PATH = DB_PATH;
        // Force synthetic embeddings to avoid external dependencies (Ollama/Transformers)
        process.env.OM_EMBEDDINGS = "synthetic";
        // Disable auto-reflection to prevent LLM timeouts during basic store
        process.env.OM_LG_REFLECTIVE = "false";

        // Mock global fetch to handle LLM calls (e.g. from explicit reflection tests)
        // Mock global fetch to handle LLM calls (e.g. from explicit reflection tests)
        // Mock global fetch to route requests directly to Elysia app
        originalFetch = global.fetch;
        (global as any).fetch = async (url: string | URL | Request, init?: RequestInit) => {
            const u = String(url);

            // Route to In-Memory Application
            if (u.startsWith(BASE_URL)) {
                // Create a request object that looks like it came from the network
                const req = new Request(url, init);
                const res = await serverMod.app.handle(req);
                return res;
            }

            // Mock Ollama Generation
            if (u.includes("/api/generate") || u.includes("/api/chat")) {
                return new Response(JSON.stringify({
                    response: "Mock LLM Response",
                    done: true,
                    message: { content: "Mock LLM Response" }
                }), { status: 200 });
            }

            return originalFetch(url, init);
        };

        // Ensure directory exists
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // 2. Dynamic Import & Config Reload
        const cfgMod = await import("../../src/core/cfg");
        cfgMod.reloadConfig();
        cfgMod.env.apiKey = "system-client-suite-key";
        cfgMod.env.adminKey = "system-client-suite-key";
        cfgMod.env.port = 0;
        cfgMod.env.verbose = false;
        cfgMod.env.dbPath = DB_PATH;
        cfgMod.env.embKind = "synthetic"; // Explicitly update loaded config
        cfgMod.env.lgReflective = false;

        const serverMod = await import("../../src/server/index");
        const clientMod = await import("../../src/client");
        const dbMod = await import("../../src/core/db");

        // CRITICAL: Clear any lingering DB connections or global Statement Cache from other tests
        // This prevents "internal error" or "no such column" due to statement reuse across DB instances
        await dbMod.closeDb();

        const migrateMod = await import("../../src/core/migrate"); // Import migration engine
        // Run Migrations explicitly
        await migrateMod.runMigrations();

        const schedMod = await import("../../src/core/scheduler");
        const memMod = await import("../../src/core/memory");

        stopServer = serverMod.stopServer;
        stopAllMaintenance = schedMod.stopAllMaintenance;
        closeDb = dbMod.closeDb;
        MemoryClient = clientMod.MemoryClient;
        AdminClient = clientMod.AdminClient;

        // Ensure clean state once at start
        dynamicApiKey = "system-client-suite-key";

        server = serverMod.app.listen(0);
        const actualServer = server.server;
        const port = actualServer?.port || 0;

        if (!port) {
            console.error("[TEST] Failed to get dynamic port. Server object keys:", Object.keys(server));
            if (server.server) console.error("[TEST] Inner Server keys:", Object.keys(server.server));
            throw new Error("Failed to get dynamic port from server instance");
        }

        console.log(`[TEST] Server listening on ${port}`);
        BASE_URL = `http://localhost:${port}`;
        cfgMod.env.port = port;
    }, 60000);

    beforeEach(async () => {
        dynamicApiKey = "system-client-suite-key";
    });

    afterAll(async () => {
        if (server) await server.stop();
        if (stopServer) await stopServer();
        // Restore global fetch
        if (originalFetch) (global as any).fetch = originalFetch;

        if (stopAllMaintenance) await stopAllMaintenance();
        if (closeDb) await closeDb();

        // Wait for potential async effects to settle
        await new Promise(r => setTimeout(r, 200));

        // Cleanup temporary database using Bun.file
        if (DB_PATH && DB_PATH.includes("test_client_suite_")) {
            const files = [DB_PATH, `${DB_PATH}-shm`, `${DB_PATH}-wal`];
            for (const f of files) {
                try {
                    const file = Bun.file(f);
                    if (await file.exists()) {
                        const fs = await import("node:fs");
                        fs.unlinkSync(f);
                    }
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }
    }, 60000);

    const client = () => new MemoryClient({ baseUrl: BASE_URL, token: dynamicApiKey, defaultUser: TEST_USER });
    const admin = () => new AdminClient({ baseUrl: BASE_URL, token: dynamicApiKey });

    // --- Basic CRUD & Auth ---

    test("Client connection and health check", async () => {
        const c = client();
        const healthy = await c.health();
        expect(healthy).toBe(true);
    });

    test("Client add and retrieve memory", async () => {
        const c = client();
        const added = await c.add("Integration Test Content", { tags: ["suite-test"] });
        expect(added.id).toBeDefined();
        expect(added.content).toBe("Integration Test Content");

        const fetched = await c.get(added.id);
        expect(fetched?.id).toBe(added.id);
        expect(fetched?.tags).toContain("suite-test");
    });

    test("Client update memory (PATCH)", async () => {
        const c = client();
        const item = await c.add("Original Content");
        await c.update(item.id, "Updated Content", ["new-tag"]);

        const updated = await c.get(item.id);
        expect(updated?.content).toBe("Updated Content");
        expect(updated?.tags).toContain("new-tag");
    });

    test("Client Auth failure handling", async () => {
        const c = new MemoryClient({ baseUrl: BASE_URL, token: "wrong-key" });
        try {
            // Bypass long retries for this test specifically
            const clientAny = c as any;
            if (!clientAny.requestOptions) clientAny.requestOptions = {};
            clientAny.requestOptions.retries = 0;

            await c.add("Should fail");
            expect(true).toBe(false);
        } catch (e: any) {
            expect(e.message).toMatch(/401|403|incorrect|Invalid API Key/i);
        }
    });

    // --- Temporal Graph ---

    test("Client Temporal Graph operations", async () => {
        const c = client();

        // Add Fact
        const fact = await c.addFact({ subject: "Client", predicate: "tests", object: "Suite" }, TEST_USER);
        expect(fact.id).toBeDefined();

        // Search Facts
        const facts = await c.getFacts({ subject: "Client" });
        expect(facts.length).toBeGreaterThan(0);
        expect(facts[0].object).toBe("Suite");

        // Add Edge
        const fact2 = await c.addFact({ subject: "Suite", predicate: "contains", object: "Tests" }, TEST_USER);
        const edge = await c.addEdge({
            sourceId: fact.id,
            targetId: fact2.id,
            relationType: "structure",
            weight: 1.0
        });
        expect(edge.ok).toBe(true);

        const edges = await c.getEdges({ sourceId: fact.id });
        expect(edges.length).toBe(1);

        // Timeline
        const timeline = await c.timeline("Client");
        expect(timeline).toBeDefined();
        // We just added a fact for "Client", so timeline should have it
        expect(timeline.length).toBeGreaterThan(0);
        expect(timeline[0].predicate).toBeDefined();

        // Timeline
        const timeline2 = await c.timeline("Client");
        expect(timeline2).toBeDefined();
        expect(timeline2.length).toBeGreaterThan(0);
        expect(timeline2[0].predicate).toBeDefined();
    });

    // --- Advanced Features ---

    test("Compression API", async () => {
        const c = client();
        const text = "Redundant text ".repeat(10);
        const res = await c.compress(text, "semantic");
        expect(res).toBeDefined();
        expect(res.metrics).toBeDefined();

        const stats = await c.getCompressionStats();
        expect(stats.total).toBeGreaterThanOrEqual(0); // Might be 0 if first run
    });

    test("Dynamics API", async () => {
        const c = client();
        const sal = await c.calculateSalience({
            initialSalience: 0.8,
            decayLambda: 0.1,
            timeElapsedDays: 5
        });
        expect(sal.success).toBe(true);
        expect(sal.calculatedSalience).toBeLessThan(0.8);

        const graph = await c.getWaypointGraph();
        expect(graph.success).toBe(true);
    });

    test("IDE API Session Flow", async () => {
        const c = client();
        const start = await c.ide.startSession({ projectName: "SuiteProj", ideName: "TestIDE" });
        expect(start.sessionId).toBeDefined();

        await c.ide.sendEvent({
            sessionId: start.sessionId,
            eventType: "open",
            filePath: "/test.ts"
        });

        const patterns = await c.ide.getPatterns(start.sessionId);
        expect(patterns.success).toBe(true);

        const end = await c.ide.endSession(start.sessionId);
        expect(end.summaryMemoryId).toBeDefined();
    });

    // --- LangGraph & LGM ---

    test("LangGraph Store/Retrieve/Context", async () => {
        const c = client();
        const stored = await c.lgm.store({ node: "agent", content: "State Data", graphId: "g1" });
        expect(stored.success).toBe(true);

        const retrieved = await c.lgm.retrieve({ node: "agent", graphId: "g1" });
        expect(retrieved.success).toBe(true);
        expect(retrieved.memories.length).toBeGreaterThan(0);

        const ctx = await c.lgm.getContext({ node: "agent", graphId: "g1" });
        expect(ctx.success).toBe(true);
    });

    test("LGM Reflection & Config", async () => {
        const c = client();
        const reflect = await c.lgm.reflect({
            node: "agent",
            content: "Reflection Content",
        });
        expect(reflect.success).toBe(true);

        const cfg = await c.lgm.getConfig();
        expect(cfg.success).toBe(true);
    });

    // --- Admin Client ---

    test("Admin Client: System Metrics", async () => {
        const a = admin();
        const res = await a.system.getMetrics();
        expect(res.success).toBe(true);
        expect(res.metrics).toBeDefined();
        expect(res.metrics.memory).toBeDefined();

        const stats = await a.dashboard.getStats();
        expect(stats?.totalMemories).toBeDefined();
    });
});
