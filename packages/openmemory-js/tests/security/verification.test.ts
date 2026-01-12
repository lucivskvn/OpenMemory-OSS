
import { describe, expect, test, beforeAll } from "bun:test";
import { AesGcmProvider, getEncryption, resetSecurity } from "../../src/core/security";
import { env, reloadConfig } from "../../src/core/cfg";

describe("Security Verification", () => {
    beforeAll(() => {
        // Force test environment settings
        process.env.OM_ENCRYPTION_ENABLED = "true";
        process.env.OM_ENCRYPTION_KEY = "test-secret-key-minimum-16-chars";
        reloadConfig();
        resetSecurity();
    });

    test("Get Encryption Provider Returns AesGcmProvider", () => {
        const provider = getEncryption();
        expect(provider).toBeInstanceOf(AesGcmProvider);
    });

    test("Encrypt and Decrypt Round Trip", async () => {
        const provider = getEncryption();
        const plaintext = "Sensitive Data 123";
        const encrypted = await provider.encrypt(plaintext);

        expect(encrypted).not.toBe(plaintext);
        expect(encrypted).toStartWith("v1:");

        const decrypted = await provider.decrypt(encrypted);
        expect(decrypted).toBe(plaintext);
    });

    test("Decryption Fails with Wrong Key", async () => {
        const provider1 = new AesGcmProvider("key-one-minimum-16-chars");
        const provider2 = new AesGcmProvider("key-two-minimum-16-chars");

        const encrypted = await provider1.encrypt("secret");

        // precise validation requires handling promise rejection
        try {
            await provider2.decrypt(encrypted);
            expect(true).toBe(false); // Should not reach here
        } catch (e: any) {
            expect(e.message).toContain("Decryption failed");
        }
    });

    test("Key Verification Returns True", async () => {
        const provider = getEncryption();
        // Since we are mocking AesGcmProvider via getEncryption, verifyKey isn't on the interface
        // We need to cast it or verify implementation details.
        // But wait, verifyKey IS NOT on EncryptionProvider interface in the source code I read?
        // Let's check the source code again. 
        // Ah, verifyKey IS on AesGcmProvider class but maybe not interface.
        // Let's check if we can call it.
        if (provider instanceof AesGcmProvider) {
            const isValid = await provider.verifyKey();
            expect(isValid).toBe(true);
        }
    });
});
