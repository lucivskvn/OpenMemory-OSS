
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Memory } from "../../src/core/memory";
import { q, waitForDb } from "../../src/core/db";
import { getUniqueDbPath, cleanupIfSuccess, forceConfigReinit } from "../test_utils";
import { computeSimhash } from "../../src/memory/hsg";

const TEST_DB = getUniqueDbPath("dedup");
const USER_ID = "dedup_user";

describe("Deduplication Logic", () => {
    beforeEach(async () => {
        Bun.env.OM_DB_PATH = TEST_DB;
        await forceConfigReinit();
        await waitForDb();

        // Setup user
        await q.insUser.run(USER_ID, "Dedup Test User", 0, Date.now(), Date.now());
    });

    afterEach(async () => {
        await cleanupIfSuccess(TEST_DB);
    });

    test("Idempotency: Adding identical content should return same ID", async () => {
        const memory = new Memory(USER_ID);
        const content = "This is a unique thought.";

        const result1 = await memory.add(content);
        const result2 = await memory.add(content);

        expect(result2.id).toBe(result1.id);

        // Verify only 1 row exists
        const count = await q.getMemCount.get(USER_ID);
        expect(count!.c).toBe(1);
    });

    test("Simhash computation sanity", () => {
        const s1 = computeSimhash("Hello World");
        const s2 = computeSimhash("Hello World");
        expect(s1).toBe(s2);

        const s3 = computeSimhash("Hello World 2");
        expect(s1).not.toBe(s3);
    });
});
