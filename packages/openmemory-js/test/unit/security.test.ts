import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { AesGcmProvider, getEncryption, resetSecurity, NoopProvider } from "../../src/core/security";
import { env } from "../../src/core/cfg";
import { randomBytes } from "crypto";
import { getContext, runInContext } from "../../src/core/context";

// Mock env if needed, but getEncryption relies on imported 'env' from dynamic cfg.
// Since cfg.ts reads process.env on parse, we can modify process.env and trigger reload.

describe("Security Core", () => {
    const originalEnv = { ...process.env };

    afterAll(() => {
        process.env.OM_ENCRYPTION_ENABLED = originalEnv.OM_ENCRYPTION_ENABLED;
        process.env.OM_ENCRYPTION_KEY = originalEnv.OM_ENCRYPTION_KEY;
        process.env.OM_ENCRYPTION_SECONDARY_KEYS = originalEnv.OM_ENCRYPTION_SECONDARY_KEYS;
        process.env.OM_ENCRYPTION_SALT = originalEnv.OM_ENCRYPTION_SALT;
        resetSecurity();
    });

    beforeEach(() => {
        resetSecurity();
        process.env.OM_ENCRYPTION_ENABLED = "false";
        process.env.OM_ENCRYPTION_KEY = "";
        process.env.OM_ENCRYPTION_SECONDARY_KEYS = "";
        process.env.OM_ENCRYPTION_SALT = "test-salt-123";
    });

    test("defaults to NoopProvider when disabled", () => {
        const provider = getEncryption();
        expect(provider).toBeInstanceOf(NoopProvider);
    });

    test("encrypts and decrypts with AesGcmProvider", async () => {
        const secret = randomBytes(32).toString("hex"); // 64 chars > 32
        const provider = new AesGcmProvider(secret);

        const plaintext = "Hello OpenMemory Secure World!";
        const ciphertext = await provider.encrypt(plaintext);

        expect(ciphertext).not.toBe(plaintext);
        expect(ciphertext).toMatch(/^v1:[a-zA-Z0-9+/=]+:[a-zA-Z0-9+/=]+$/);

        const decrypted = await provider.decrypt(ciphertext);
        expect(decrypted).toBe(plaintext);
    });

    test("supports key rotation (decrypt with secondary key)", async () => {
        const oldKey = randomBytes(32).toString("hex");
        const newKey = randomBytes(32).toString("hex");

        // Simulate data encrypted with OLD key
        const oldProvider = new AesGcmProvider(oldKey);
        const ciphertext = await oldProvider.encrypt("Data from the past");

        // New provider has NEW key as primary, OLD key as secondary
        const newProvider = new AesGcmProvider(newKey, [oldKey]);

        // Should be able to decrypt
        const decrypted = await newProvider.decrypt(ciphertext);
        expect(decrypted).toBe("Data from the past");

        // New encryption uses NEW key
        const newCiphertext = await newProvider.encrypt("Data from the future");

        // Old provider (only old key) should fail to decrypt new ciphertext
        try {
            await oldProvider.decrypt(newCiphertext);
            expect(true).toBe(false); // Should fail
        } catch (e) {
            expect(e).toBeDefined();
        }
    });

    test("fails instantiation with weak key", () => {
        expect(() => {
            new AesGcmProvider("weak");
        }).toThrow("at least 32 characters");
    });

    test("handles non-encrypted content transparently if not prefixed", async () => {
        const provider = new AesGcmProvider(randomBytes(32).toString("hex"));
        const plain = "not-encrypted-data";
        expect(await provider.decrypt(plain)).toBe(plain);
    });

    test("verifies key functionality", async () => {
        const provider = new AesGcmProvider(randomBytes(32).toString("hex"));
        expect(await provider.verifyKey()).toBe(true);
    });
});
