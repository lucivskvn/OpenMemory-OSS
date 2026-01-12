
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { addHsgMemory, updateMemory } from "../../src/memory/hsg";
import { vectorStore, runAsync } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { MemoryRow } from "../../src/core/types";
import { q } from "../../src/core/db";

describe("Vector Integrity", () => {
    const userId = "vec_leak_user_" + Date.now();

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
        await runAsync("DELETE FROM memories WHERE user_id = ?", [userId]);
        await runAsync("DELETE FROM vectors WHERE user_id = ?", [userId]);
    });

    afterAll(async () => {
        await runAsync("DELETE FROM memories WHERE user_id = ?", [userId]);
        await runAsync("DELETE FROM vectors WHERE user_id = ?", [userId]);
    });

    test("Vector Leak Reproduction: Changing sector should remove old vector", async () => {
        // 1. Add "Episodic" Memory
        const content1 = "Yesterday I went to the park.";
        const { id } = await addHsgMemory(content1, null, {}, userId);

        const v1 = await vectorStore.getVectorsById(id, userId);
        expect(v1.length).toBeGreaterThan(0);
        const hasEpisodic = v1.some(v => v.sector === "episodic");
        // Depending on classifier, it might be episodic. 
        console.log("Initial Sectors:", v1.map(v => v.sector));
        if (hasEpisodic) {
            expect(hasEpisodic).toBe(true);
        }

        // 2. Update to "Procedural" Content
        // "To install bun, run curl ..."
        const content2 = "To install bun, run curl https://bun.sh/install";
        await updateMemory(id, content2, undefined, undefined, userId);

        // 3. Check Vectors
        const v2 = await vectorStore.getVectorsById(id, userId);
        console.log("Updated Sectors:", v2.map(v => v.sector));

        // Expectation: Should NOT contain "episodic" if the new content is purely procedural.
        // If leak exists, "episodic" will still be there.

        // Note: The classifier might keep episodic if it's fuzzy, but "To install..." is strongly procedural.
        // Let's assert that we don't have DUPLICATE counts or unexpected retention.

        // Stronger assertion: 
        // If strict leak: v2.length should be (New Sectors Count). 
        // If leak: v2.length will be (Old Sectors Count) + (New Sectors Count) (minus overlaps).

        // Let's assume content2 classifies as 'procedural' mainly.
        const hasProcedural = v2.some(v => v.sector === "procedural");
        expect(hasProcedural).toBe(true);

        // The real bug is if the old sector remains when it shouldn't.
        // If content1 was episodic, and content2 is procedural, v2 should NOT have episodic.
        const hasEpisodicAfter = v2.some(v => v.sector === "episodic");
        console.log("Has Episodic After Update:", hasEpisodicAfter);

        // This assertion will FAIL if the leak exists
        expect(hasEpisodicAfter).toBe(false);
    });
});
