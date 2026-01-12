import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { OpenMemoryTools } from "../../src/ai/agents";
import { getIdeContext } from "../../src/ai/ide";
import { storeNodeMem, retrieveNodeMems } from "../../src/ai/graph";
import { closeDb, runAsync, waitReady, transaction } from "../../src/core/db";
import { env } from "../../src/core/cfg";
import fs from "node:fs";
import path from "node:path";

// Setup Test Environment
const DB_PATH = path.resolve(".test_ai_integration.db");
process.env.OM_DB_PATH = DB_PATH;
process.env.OM_EMBEDDINGS = "synthetic"; // Use synthetic embeddings to avoid external API calls

describe("AI Integration Suite", () => {

    beforeAll(async () => {
        // Ensure clean state
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        await waitReady();
    });

    afterAll(async () => {
        await closeDb();
        if (fs.existsSync(DB_PATH)) {
            try { fs.unlinkSync(DB_PATH); } catch (e) { /* ignore */ }
        }
    });

    describe("Autonomy & Agents", () => {
        test("OpenMemoryTools.summarize should work", async () => {
            const tools = new OpenMemoryTools("user1");
            const summary = await tools.summarize("This is a very long text that needs summarization. It contains many details about the project.");
            expect(summary).toBeDefined();
            expect(typeof summary).toBe("string");
            expect(summary.length).toBeGreaterThan(0);
        });

        test("IDE Context should include Graph Context", async () => {
            const userId = "user_ide_1";
            const sessionId = "session_graph_1";

            // seed some graph memory
            await storeNodeMem({
                node: "plan",
                content: "We need to refactor the database schema.",
                namespace: "ide",
                graphId: sessionId,
                userId,
                tags: ["refactor"]
            });

            const ctx = await getIdeContext({
                file: "db.ts",
                content: "function init() {}",
                line: 1,
                userId,
                sessionId
            });

            expect(ctx.context.length).toBeGreaterThan(0);
            const first = ctx.context[0];
            expect(first.memoryId).toBe("graph-context");
            expect(first.content).toContain("Graph Context");
            expect(first.content).toContain("refactor the database schema");
        });
    });

    describe("Namespace Isolation", () => {
        const userId = "test_ai_iso_" + Date.now();
        const namespace = "isolated_workflow";

        test("Should retrieve only namespaced memories, ignoring others", async () => {
            const memory = new Memory(userId);

            // 1. Add "Noise" - global memories unrelated to workflow
            for (let i = 0; i < 20; i++) { // Reduced count for speed
                await memory.add(`Noise memory ${i}`, { userId, tags: ["noise"] });
            }

            // 2. Add "Signal" - workflow memories
            await storeNodeMem({
                node: "act",
                content: "Action 1: Start process",
                namespace,
                userId,
            });

            await storeNodeMem({
                node: "observe",
                content: "Observation 1: Process running",
                namespace,
                userId,
            });

            // 3. Retrieve node memories for the namespace
            const result = await retrieveNodeMems({
                node: "act",
                namespace,
                userId,
                limit: 10,
                includeMetadata: true
            });

            expect(result.items.length).toBeGreaterThan(0);
            expect(result.items[0].content).toContain("Action 1");

            // Verify content
            for (const item of result.items) {
                const meta = item.metadata as any;
                expect(meta.lgm?.namespace).toBe(namespace);
            }
        });
    });
});
