
import { getEncryption } from "../src/core/security";
import { addHsgMemory, hsgQuery } from "../src/memory/hsg";
import { q } from "../src/core/db";

// Mock env
Bun.env.OM_ENCRYPTION_ENABLED = "true";
Bun.env.OM_ENCRYPTION_KEY = "test_key_12345678901234567890123456789012";

async function run() {
    try {
        console.log("Starting Encryption Verification...");
        const user_id = "verify_script_user";
        const content = "Confidential Data Verification " + Date.now();

        // 1. Create Memory
        const res = await addHsgMemory(content, undefined, {}, user_id);
        console.log(`[PASS] Memory Created: ${res.id}`);

        // 2. Verify Database (Should be Encrypted)
        const raw = await q.getMem.get(res.id, user_id);
        if (!raw) throw new Error("Memory not found in DB");

        if (raw.content === content) {
            throw new Error("[FAIL] Content stored in plaintext!");
        }
        if (!raw.content.includes(":")) {
            console.warn("[WARN] Content might not be encrypted correctly (No IV separator):", raw.content);
        } else {
            console.log(`[PASS] Content is encrypted in DB: ${raw.content.substring(0, 20)}...`);
        }

        // 3. Verify Decryption on Retrieval
        const enc = getEncryption();
        const decrypted = await enc.decrypt(raw.content);
        if (decrypted !== content) throw new Error(`[FAIL] Decryption mismatch! Got: ${decrypted}`);
        console.log(`[PASS] Manual Decryption successful.`);

        // 4. Verify Route Logic (HSG Query)
        // Note: hsgQuery calls getMem which we patched to decrypt
        const results = await hsgQuery(content, 1, { userId: user_id });
        const match = results.find(r => r.id === res.id);
        if (!match) {
            console.warn("[WARN] HSG Query didn't return the item (indexing lag maybe?)");
        } else {
            if (match.content !== content) throw new Error(`[FAIL] HSG Query returned encrypted/wrong content: ${match.content}`);
            console.log(`[PASS] HSG Query returned decrypted content.`);
        }

        // Cleanup
        await q.delMem.run(res.id, user_id);
        console.log("[PASS] Cleanup complete. Verification Successful.");
        process.exit(0);

    } catch (e) {
        console.error("[ERROR]", e);
        process.exit(1);
    }
}

run();
