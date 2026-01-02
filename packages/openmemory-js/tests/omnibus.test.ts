import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Memory } from "../src/core/memory";
import { run_async, q, close_db } from "../src/core/db";
import { run_decay_process, stop_hsg_maintenance } from "../src/memory/hsg";
import { existsSync, unlinkSync } from "fs";

// Mock time for evolutionary stability
let mockTime: number | null = null;
const originalNow = Date.now;
Date.now = () => (mockTime !== null ? mockTime : originalNow());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup(user_id: string) {
    await run_async(`DELETE FROM memories`);
    try { await run_async(`DELETE FROM vectors`); } catch { }
    try { await run_async(`DELETE FROM openmemory_vectors`); } catch { }
    try { await run_async(`DELETE FROM waypoints`); } catch { }
    try { await run_async(`DELETE FROM users`); } catch { }
    if (global.gc) global.gc();
}

// Force synthetic for reliability
process.env.OM_EMBEDDINGS = "synthetic";

async function check_vec(id: string) {
    const row = await q.get_mem.get(id);
    if (!row) console.error(`[DEBUG] Memory ${id} NOT FOUND in DB`);
    // else console.log(`[DEBUG] Memory ${id} vector length: ${row.mean_vec ? row.mean_vec.length : 'NULL'}`);
}

describe("OpenMemory Omnibus Tests", () => {
    afterAll(() => {
        stop_hsg_maintenance();
    });

    test("Evolutionary Stability (10 Generations)", async () => {
        const mem = new Memory();
        const uid = "u1";
        await cleanup(uid);

        // 1. Genesis
        mockTime = originalNow();
        const res_pop = await mem.add("I am the Popular Memory", { user_id: uid });
        const res_unpop = await mem.add("I am the Unpopular Memory", { user_id: uid });
        const pid = res_pop.id;
        const uid_mem = res_unpop.id;

        // 2. Evolution Loop
        for (let gen = 0; gen < 10; gen++) {
            // Advance 1 day per generation (86400000 ms)
            if (mockTime !== null) mockTime += 86400 * 1000;

            // Reinforce Popular every other generation
            if (gen % 2 === 0) {
                await mem.search("Popular", { user_id: uid, limit: 1 });
            }

            // Manually trigger decay to simulate time passing for all memories
            await run_decay_process();
        }

        // 3. Final Judgment
        if (mockTime !== null) mockTime += 86400 * 1000;

        // Check Salience via DB directly to avoid search side-effects
        const pop_final = await q.get_mem.get(pid);
        const unpop_final = await q.get_mem.get(uid_mem);

        expect(pop_final).toBeDefined();
        expect(unpop_final).toBeDefined();

        const s_pop = pop_final?.salience ?? 0;
        const s_unpop = unpop_final?.salience ?? 0;

        console.log(` -> Generation 10 Results: Popular=${s_pop.toFixed(4)}, Unpopular=${s_unpop.toFixed(4)}`);

        expect(s_pop).toBeGreaterThan(s_unpop);
        mockTime = null; // Reset
    });

    test("Boolean Metadata Logic", async () => {
        const mem = new Memory();
        const uid = "filter_user_js";
        await cleanup(uid);

        // Wait 500ms for WAL safety buffer from previous test deletions if any
        await sleep(500);

        // 1. High Priority, Work context
        await mem.add("Finish Report", { user_id: uid, tags: ["work", "urgent"], priority: 10 });
        // 2. Low Priority, Work context
        await mem.add("Clean Desk", { user_id: uid, tags: ["work"], priority: 2 });
        // 3. High Prioriy, Home context
        const res3 = await mem.add("Pay Bills", { user_id: uid, tags: ["home", "urgent"], priority: 10 });

        // Ensure persistence
        await sleep(1000);
        await check_vec(res3.id);

        // Since search doesn't support complex filter syntax yet, we search semantic and verify post-hoc
        const hits = await mem.search("Report", { user_id: uid, limit: 10 });

        // Check logic
        const found = hits.some((h: any) => {
            const tags = typeof h.tags === 'string' ? JSON.parse(h.tags) : h.tags || [];
            return tags.includes("urgent") && tags.includes("work");
        });

        expect(found).toBe(true);
    });

    test("Content Robustness", async () => {
        const mem = new Memory();
        const uid = "format_user_js";
        await cleanup(uid);
        await sleep(500);

        const payloads = {
            "HTML": "<div><h1>Title</h1><p>Body</p></div>",
            "JSON": '{"key": "value", "list": [1, 2, 3]}',
            "Markdown": "| Col1 | Col2 |\n|---|---|\n| Val1 | Val2 |"
        };

        for (const [fmt, content] of Object.entries(payloads)) {
            await mem.add(content, { user_id: uid });
            await sleep(200);

            const hits = await mem.search(content.substring(0, 10), { user_id: uid, limit: 1 });
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
