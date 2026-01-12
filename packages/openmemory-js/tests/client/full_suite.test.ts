import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";

// Force a specific test port to avoid collision
const TEST_PORT = 31240;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_USER = "client_suite_user";

describe("Client SDK Comprehensive Suite", () => {
    let server: any;
    let stopServer: any;
    let stopAllMaintenance: any;
    let closeDb: any;
    let MemoryClient: any;
    let AdminClient: any;
    let dynamicApiKey: string;

    beforeAll(async () => {
        // 1. Set Environment Variables
        process.env.OM_PORT = String(TEST_PORT);
        process.env.OM_VERBOSE = "false";
        process.env.OM_API_KEY = "system-client-suite-key";
        process.env.OM_ADMIN_KEY = "system-client-suite-key";
        // Force synthetic embeddings to avoid external dependencies (Ollama/Transformers)
        process.env.OM_EMBEDDINGS = "synthetic";

        // 2. Dynamic Import & Config Reload
        const cfgMod = await import("../../src/core/cfg");
        cfgMod.reloadConfig();
        cfgMod.env.apiKey = "system-client-suite-key";
        cfgMod.env.adminKey = "system-client-suite-key";
        cfgMod.env.port = TEST_PORT;
        cfgMod.env.verbose = false;
        cfgMod.env.embKind = "synthetic"; // Explicitly update loaded config

        const serverMod = await import("../../src/server/index");
        const clientMod = await import("../../src/client");
        const dbMod = await import("../../src/core/db");
        const schedMod = await import("../../src/core/scheduler");
        const memMod = await import("../../src/core/memory");

        stopServer = serverMod.stopServer;
        stopAllMaintenance = schedMod.stopAllMaintenance;
        closeDb = dbMod.closeDb;
        MemoryClient = clientMod.MemoryClient;
        AdminClient = clientMod.AdminClient;
        const q = dbMod.q;
        const runAsync = dbMod.runAsync;

        // Clean DB
        const mem = new memMod.Memory(TEST_USER);
        await mem.deleteAll();
        await runAsync("DELETE FROM temporal_facts WHERE user_id = ?", [TEST_USER]);

        // Setup API Key table if needed (managed by beforeEach usually, but init here)
        dynamicApiKey = "system-client-suite-key";

        // Start Server
        server = serverMod.app.listen(TEST_PORT);
        console.log(`[TEST] Server listening on ${TEST_PORT}`);
    });

    afterAll(async () => {
        if (server) server.stop();
        if (stopServer) stopServer();
        if (stopAllMaintenance) await stopAllMaintenance();
        if (closeDb) await closeDb();
        console.log("[TEST] Server stopped");
    });

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
            await c.add("Should fail");
            expect(true).toBe(false);
        } catch (e: any) {
            expect(e.message).toMatch(/401|403/);
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
        const start = await c.startIdeSession({ projectName: "SuiteProj", ideName: "TestIDE" });
        expect(start.sessionId).toBeDefined();

        await c.sendIdeEvent({
            sessionId: start.sessionId,
            eventType: "open",
            fileParams: { path: "/test.ts" }
        });

        const patterns = await c.getIdePatterns(start.sessionId);
        expect(patterns.success).toBe(true);

        const end = await c.endIdeSession(start.sessionId);
        expect(end.summaryMemoryId).toBeDefined();
    });

    // --- LangGraph & LGM ---

    test("LangGraph Store/Retrieve/Context", async () => {
        const c = client();
        const stored = await c.lgStore("agent", "State Data", { graphId: "g1", namespace: "n1" });
        expect(stored.success).toBe(true);

        const retrieved = await c.lgRetrieve("agent", { graphId: "g1", namespace: "n1" });
        expect(retrieved.success).toBe(true);
        expect(retrieved.memories.length).toBeGreaterThan(0);

        const ctx = await c.lgContext("agent", { graphId: "g1", namespace: "n1" });
        expect(ctx.success).toBe(true);
    });

    test("LGM Reflection & Config", async () => {
        const c = client();
        const reflect = await c.lgmReflection({
            node: "agent",
            content: "Reflection Content",
            depth: "shallow"
        });
        expect(reflect.success).toBe(true);

        const cfg = await c.lgmConfig();
        expect(cfg.success).toBe(true);
    });

    // --- Admin Client ---

    test("Admin Client: System Metrics", async () => {
        const a = admin();
        const metrics = await a.getSystemMetrics();
        expect(metrics.success).toBe(true);
        expect(metrics.metrics).toBeDefined();
        expect(metrics.metrics.memory).toBeDefined();

        const stats = await a.getDashboardStats();
        expect(stats.totalMemories).toBeDefined();
    });
});
