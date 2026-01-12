import { describe, expect, test, mock, beforeEach } from "bun:test";
import { AesGcmProvider, SecurityError, getEncryption, resetSecurity } from "../../src/core/security";
import { env } from "../../src/core/cfg";
import { runAsync, getAsync } from "../../src/core/db";

// Mock environment for security testing
mock.module("../../src/core/cfg", () => ({
    env: {
        verbose: false,
        encryptionEnabled: true,
        // Using a known key (must be >= 16 chars)
        encryptionKey: "1234567890123456",
        apiKey: "default-api-key"
    },
    reloadConfig: () => { }
}));

// Mock DB module
mock.module("../../src/core/db", () => ({
    runAsync: mock(() => Promise.resolve(1)),
    getAsync: mock(() => Promise.resolve({ id: "test" })),
    allAsync: mock(() => Promise.resolve([])),
    transaction: { run: (fn: any) => fn() },
    q: {},
}));

describe("Core Infrastructure", () => {
    describe("Security", () => {
        beforeEach(() => {
            resetSecurity();
        });

        test("AesGcmProvider encrypts and decrypts correctly", async () => {
            const provider = new AesGcmProvider("1234567890123456");
            const plain = "Hello World";
            const cipher = await provider.encrypt(plain);

            expect(cipher).toMatch(/^(enc:|v1:)/);
            expect(await provider.decrypt(cipher)).toBe(plain);
        });

        test("AesGcmProvider throws SecurityError on invalid cipher", async () => {
            const provider = new AesGcmProvider("1234567890123456");
            const invalid = "enc:invalid:data";

            try {
                await provider.decrypt(invalid);
                expect(true).toBe(false); // Fail if no error
            } catch (e) {
                expect(e).toBeInstanceOf(SecurityError);
            }
        });

        test("AesGcmProvider handles wrong key", async () => {
            const provider1 = new AesGcmProvider("1234567890123456"); // Key A
            const provider2 = new AesGcmProvider("ABCDEFGHIJKLMNOP"); // Key B

            const cipher = await provider1.encrypt("Secret");

            try {
                await provider2.decrypt(cipher);
                expect(true).toBe(false);
            } catch (e) {
                expect(e).toBeInstanceOf(SecurityError);
            }
        });
    });

    describe("DB", () => {
        test("runAsync returns expected type", async () => {
            const result = await runAsync("SELECT 1");
            expect(typeof result).toBe("number");
        });
    });
});
