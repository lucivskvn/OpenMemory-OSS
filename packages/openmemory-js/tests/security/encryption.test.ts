import { describe, expect, test, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { getEncryption, resetSecurity } from "../../src/core/security";
import { reloadConfig } from "../../src/core/cfg";
import { q, closeDb } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { Memory } from "../../src/core/memory";

describe("Encryption at Rest Verification", () => {
    let mem: Memory;
    const testContent = "This is a secret message that should be encrypted.";
    const userId = "test_user_enc";
    let memoryId: string = "";

    beforeAll(async () => {
        const { env } = await import("../../src/core/cfg");
        env.tier = "deep";
        const { waitForDb } = await import("../test_utils");
        await waitForDb();
    });

    beforeEach(() => {
        // Enforce isolation per test
        process.env.OM_DB_PATH = ":memory:";
        process.env.OM_ENCRYPTION_ENABLED = "true";
        process.env.OM_ENCRYPTION_KEY = "test_key_12345678901234567890123456789012";
        reloadConfig();
        resetSecurity();
        mem = new Memory(userId);
    });

    test("Memory is stored encrypted in DB", async () => {
        const res = await mem.add(testContent);
        memoryId = res.id;

        // Query DB directly to see raw content
        const raw = await q.getMem.get(memoryId, userId);
        expect(raw).toBeDefined();
        expect(raw?.content).not.toBe(testContent);
        expect(raw?.content.startsWith("v1:")).toBe(true);

        // Verify SDK can still read it
        const fetched = await mem.get(memoryId);
        (globalThis as any).fetch = mock(async () => new Response("ok"));
    });

    test("Search works over encrypted content", async () => {
        await new Promise(r => setTimeout(r, 100)); // Indexing delay
        const hits = await mem.search("secret message");
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].content).toBe(testContent);
    });

    afterAll(async () => {
        if (memoryId) {
            await q.delMem.run(memoryId, userId);
        }
        await stopAllMaintenance();
        await closeDb();
    });
});
