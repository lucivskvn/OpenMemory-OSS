import { describe, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { test, cleanupIfSuccess, waitForDb } from "../test_utils";
import { getEncryption, resetSecurity } from "../../src/core/security";
import { reloadConfig } from "../../src/core/cfg";
import { q, closeDb } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { Memory } from "../../src/core/memory";

import path from "node:path";
import fs from "node:fs";

describe("Encryption at Rest Verification", () => {
    let mem: Memory;
    const testContent = "This is a secret message that should be encrypted.";
    const userId = "test_user_enc";
    let memoryId: string = "";
    const DB_PATH = path.join(process.cwd(), "tests/data", `test_encryption_${Date.now()}.sqlite`);

    beforeAll(async () => {
        const { env } = await import("../../src/core/cfg");
        env.tier = "deep";

        await closeDb();
        process.env.OM_DB_PATH = DB_PATH;
        process.env.OM_ENCRYPTION_ENABLED = "true";
        process.env.OM_ENCRYPTION_KEY = "test_key_12345678901234567890123456789012";
        process.env.OM_ENCRYPTION_SALT = "test_salt_123";
        reloadConfig();
        resetSecurity();

        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        await waitForDb();
        mem = new Memory(userId);
    }, 10000);

    afterAll(async () => {
        await stopAllMaintenance();
        await cleanupIfSuccess(DB_PATH);
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
        if (!fetched) throw new Error("Memory not found after encryption");
        expect(fetched.content).toBe(testContent);
    });

    test("Search works over encrypted content", async () => {
        await new Promise(r => setTimeout(r, 100)); // Indexing delay
        const hits = await mem.search("secret message");
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].content).toBe(testContent);
    });
});
