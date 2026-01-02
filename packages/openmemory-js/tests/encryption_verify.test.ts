
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { get_encryption } from "../src/core/security";
import { add_hsg_memory, hsg_query } from "../src/memory/hsg";
import { q } from "../src/core/db";
import { Memory } from "../src/core/memory"; // Added import for Memory

// Mock env for test
process.env.OM_ENCRYPTION_ENABLED = "true";
process.env.OM_ENCRYPTION_KEY = "test_key_12345678901234567890123456789012"; // 32 chars

describe("Encryption at Rest Verification", () => {
    const mem = new Memory("test_user_enc");
    const test_content = "This is a secret message that should be encrypted.";
    const user_id = "test_user_enc";
    let memory_id: string; // Changed back to let
    let created_memory_id: string; // Added to store the ID of the created memory

    beforeAll(async () => {
        process.env.OM_ENCRYPTION_ENABLED = "true";
        process.env.OM_ENCRYPTION_KEY = "test-secret-key-must-be-long-enough"; // 32+ chars ideally
        const { reset_security } = await import("../src/core/security");
        reset_security();
        // Ensure DB is ready (might need init if not already)
        // src/server/index.ts has side effects, avoiding it if possible
        // But we need DB connection. q is imported from core/db.
    });

    test("Encrypts data on storage", async () => {
        const res = await add_hsg_memory(test_content, undefined, {}, user_id);
        memory_id = res.id;
        console.log("Created memory:", memory_id);

        // Fetch raw from DB to verify it's encrypted
        const raw = await q.get_mem.get(memory_id, user_id);
        expect(raw).toBeDefined();
        if (!raw) return;

        console.log("Raw content in DB:", raw.content);
        expect(raw.content).not.toBe(test_content);
        expect(raw.content).toContain(":"); // IV:Ciphertext format (usually) or just check it's different

        // Decrypt manually to verify
        const decrypted = await get_encryption().decrypt(raw.content);
        expect(decrypted).toBe(test_content);
    });

    test("Decrypts data on retrieval (HSG Query)", async () => {
        // Allow time for indexing if async? HSG is sync for ins_mem usually
        const results = await hsg_query("secret message", 5, { user_id });
        const match = results.find(r => r.id === memory_id);

        expect(match).toBeDefined();
        if (match) {
            console.log("Retrieved content via HSG:", match.content);
            expect(match.content).toBe(test_content);
        }
    });

    afterAll(async () => {
        // Cleanup
        if (memory_id) {
            await q.del_mem.run(memory_id, user_id);
        }
        // Stop HSG Maintenance (side-effect of import)
        const { stop_hsg_maintenance } = await import("../src/memory/hsg");
        stop_hsg_maintenance();
        // Close DB to prevent test runner hang
        const { run_async } = await import("../src/core/db");
    });
});
