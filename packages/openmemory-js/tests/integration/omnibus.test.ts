import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { runAsync, q, closeDb } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { runDecayProcess } from "../../src/memory/hsg";

// Mock time for evolutionary stability
let mockTime: number | null = null;
const originalNow = Date.now;
Date.now = () => (mockTime !== null ? mockTime : originalNow());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup(userId: string) {
    await runAsync(`DELETE FROM memories`);
    try { await runAsync(`DELETE FROM vectors`); } catch { }
    try { await runAsync(`DELETE FROM openmemory_vectors`); } catch { }
    try { await runAsync(`DELETE FROM waypoints`); } catch { }
    try { await runAsync(`DELETE FROM users`); } catch { }
    if (global.gc) global.gc();
}

async function checkVector(id: string) {
    const row = await q.getMem.get(id);
    if (!row) console.error(`[DEBUG] Memory ${id} NOT FOUND in DB`);
}

// Force synthetic for reliability
process.env.OM_EMBEDDINGS = "synthetic";

describe("OpenMemory Omnibus Tests", () => {
    let mem: Memory;

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
        const mod = await import("../../src/core/memory");
        mem = new mod.Memory();
    });

    afterAll(async () => {
        await stopAllMaintenance();
        await closeDb();
    });

    test("Evolutionary Stability (10 Generations)", async () => {
        const uid = "u1";
        await cleanup(uid);

        // 1. Genesis
        mockTime = originalNow();
        const resPop = await mem.add("I am the Popular Memory", { userId: uid });
        const resUnpop = await mem.add("I am the Unpopular Memory", { userId: uid });
        const pid = resPop.id;
        const uidMem = resUnpop.id;

        // 2. Evolution Loop
        for (let gen = 0; gen < 10; gen++) {
            // Advance 1 day per generation (86400000 ms)
            if (mockTime !== null) mockTime += 86400 * 1000;

            // Reinforce Popular every other generation
            if (gen % 2 === 0) {
                await mem.search("Popular", { userId: uid, limit: 1 });
            }

            // Manually trigger decay to simulate time passing for all memories
            await runDecayProcess();
        }

        // 3. Final Judgment
        if (mockTime !== null) mockTime += 86400 * 1000;

        // Check Salience via DB directly to avoid search side-effects
        const popFinal = await q.getMem.get(pid);
        const unpopFinal = await q.getMem.get(uidMem);

        expect(popFinal).toBeDefined();
        expect(unpopFinal).toBeDefined();

        const sPop = popFinal?.salience ?? 0;
        const sUnpop = unpopFinal?.salience ?? 0;

        console.log(` -> Generation 10 Results: Popular=${sPop.toFixed(4)}, Unpopular=${sUnpop.toFixed(4)}`);

        expect(sPop).toBeGreaterThan(sUnpop);
        mockTime = null; // Reset
    });

    test("Boolean Metadata Logic", async () => {
        const uid = "filter_user_js";
        await cleanup(uid);

        // Wait 500ms for WAL safety buffer from previous test deletions if any
        await sleep(500);

        // 1. High Priority, Work context
        await mem.add("Important Report", { userId: uid, tags: ["work", "urgent"], priority: 10 });
        // 2. Low Priority, Work context
        await mem.add("Clean Desk", { userId: uid, tags: ["work"], priority: 2 });
        // 3. High Prioriy, Home context
        const res3 = await mem.add("Pay Bills", { userId: uid, tags: ["home", "urgent"], priority: 10 });

        // Ensure persistence
        await sleep(1000);
        await checkVector(res3.id);

        // Since search doesn't support complex filter syntax yet, we search semantic and verify post-hoc
        const hits = await mem.search("Report", { userId: uid, limit: 10 });

        // Check logic
        // console.log("HITS:", JSON.stringify(hits, null, 2));
        const found = hits.some((h: any) => {
            const tags = typeof h.tags === 'string' ? JSON.parse(h.tags) : h.tags || [];
            return tags.includes("urgent") && tags.includes("work");
        });

        expect(found).toBe(true);
    });

    test("Content Robustness", async () => {
        const uid = "format_user_js";
        await cleanup(uid);
        await sleep(500);

        const payloads = {
            "HTML": "<div><h1>Title</h1><p>Body</p></div>",
            "JSON": '{"key": "value", "list": [1, 2, 3]}',
            "Markdown": "| Col1 | Col2 |\n|---|---|\n| Val1 | Val2 |"
        };

        for (const [fmt, content] of Object.entries(payloads)) {
            await mem.add(content, { userId: uid });
            await sleep(200);

            const hits = await mem.search(content.substring(0, 10), { userId: uid, limit: 1 });
            expect(hits).toBeDefined();
            expect(hits.length).toBeGreaterThan(0);

            const retrieved = hits[0].content;

            // Check containment
            const keys = ["Title", "key", "Col1"];
            const hasKey = keys.some(k => retrieved.includes(k));
            expect(hasKey).toBe(true);
        }
    });
});
