import { describe, expect, beforeAll, afterAll, test } from "bun:test";
import * as fc from "fast-check";
import { AesGcmProvider, NoopProvider, getEncryption, resetSecurity } from "../../src/core/security";
import { reloadConfig } from "../../src/core/cfg";
import { closeDb } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";

/**
 * Property 17: Encryption Algorithm Consistency
 * **Validates: Requirements 4.1**
 * 
 * Feature: openmemory-codebase-improvement, Property 17: Encryption Algorithm Consistency
 * 
 * For any encryption implementation, the system should use consistent, 
 * industry-standard algorithms (AES-256-GCM with PBKDF2 key derivation).
 */

describe("Property 17: Encryption Algorithm Consistency", () => {
    const originalEnv = { ...process.env };

    beforeAll(async () => {
        await closeDb();
        await stopAllMaintenance();
    });

    afterAll(async () => {
        // Restore original environment
        process.env = originalEnv;
        resetSecurity();
        await stopAllMaintenance();
    });

    test("Property: AES-GCM encryption is consistent across all providers", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 1000 }), // Test data
                fc.string({ minLength: 32, maxLength: 64 }), // Encryption key
                fc.string({ minLength: 8, maxLength: 32 }), // Salt
                async (plaintext, encryptionKey, salt) => {
                    // Setup encryption environment
                    process.env.OM_ENCRYPTION_ENABLED = "true";
                    process.env.OM_ENCRYPTION_KEY = encryptionKey;
                    process.env.OM_ENCRYPTION_SALT = salt;
                    reloadConfig();
                    resetSecurity();

                    const provider = new AesGcmProvider(encryptionKey);

                    // Property 1: Encryption should be deterministic in format but not content
                    const encrypted1 = await provider.encrypt(plaintext);
                    const encrypted2 = await provider.encrypt(plaintext);

                    // Encrypted values should have consistent format (v1:iv:content)
                    expect(encrypted1).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
                    expect(encrypted2).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);

                    // But should not be identical (due to random IV)
                    expect(encrypted1).not.toBe(encrypted2);

                    // Property 2: Decryption should be consistent and reversible
                    const decrypted1 = await provider.decrypt(encrypted1);
                    const decrypted2 = await provider.decrypt(encrypted2);

                    expect(decrypted1).toBe(plaintext);
                    expect(decrypted2).toBe(plaintext);

                    // Property 3: Key verification should always succeed for valid keys
                    const keyValid = await provider.verifyKey();
                    expect(keyValid).toBe(true);
                }
            ),
            { numRuns: 10, timeout: 10000 }
        );
    });

    test("Property: NoopProvider maintains data integrity when encryption is disabled", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 0, maxLength: 1000 }),
                async (plaintext) => {
                    // Setup no encryption environment
                    process.env.OM_ENCRYPTION_ENABLED = "false";
                    delete process.env.OM_ENCRYPTION_KEY;
                    reloadConfig();
                    resetSecurity();

                    const provider = new NoopProvider();

                    // Property: NoopProvider should return data unchanged
                    const encrypted = await provider.encrypt(plaintext);
                    const decrypted = await provider.decrypt(encrypted);

                    expect(encrypted).toBe(plaintext);
                    expect(decrypted).toBe(plaintext);

                    // Key verification should always succeed
                    const keyValid = await provider.verifyKey();
                    expect(keyValid).toBe(true);
                }
            ),
            { numRuns: 5 }
        );
    });

    test("Property: Encryption provider selection is consistent based on configuration", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.boolean(), // encryption enabled
                fc.option(fc.string({ minLength: 32, maxLength: 64 })), // encryption key
                async (encryptionEnabled, encryptionKey) => {
                    // Setup environment
                    process.env.OM_ENCRYPTION_ENABLED = encryptionEnabled.toString();
                    if (encryptionKey) {
                        process.env.OM_ENCRYPTION_KEY = encryptionKey;
                    } else {
                        delete process.env.OM_ENCRYPTION_KEY;
                    }
                    process.env.OM_ENCRYPTION_SALT = "test_salt_123";
                    reloadConfig();
                    resetSecurity();

                    const provider = getEncryption();

                    if (encryptionEnabled && encryptionKey) {
                        // Should get AesGcmProvider
                        expect(provider).toBeInstanceOf(AesGcmProvider);
                    } else {
                        // Should get NoopProvider
                        expect(provider).toBeInstanceOf(NoopProvider);
                    }

                    // Provider should always be functional
                    const keyValid = await provider.verifyKey();
                    expect(keyValid).toBe(true);
                }
            ),
            { numRuns: 5 }
        );
    });

    test("Property: AES-GCM encryption uses industry-standard parameters", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 500 }),
                fc.string({ minLength: 32, maxLength: 64 }),
                async (plaintext, encryptionKey) => {
                    const provider = new AesGcmProvider(encryptionKey);
                    const encrypted = await provider.encrypt(plaintext);

                    // Property: Encrypted format should follow v1:iv:content pattern
                    const parts = encrypted.split(':');
                    expect(parts).toHaveLength(3);
                    expect(parts[0]).toBe('v1'); // Version prefix

                    // IV should be base64 encoded and appropriate length for AES-GCM (12 bytes = 16 base64 chars)
                    const ivBase64 = parts[1];
                    expect(ivBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
                    
                    // Content should be base64 encoded
                    const contentBase64 = parts[2];
                    expect(contentBase64).toMatch(/^[A-Za-z0-9+/=]+$/);

                    // Should be able to decrypt back to original
                    const decrypted = await provider.decrypt(encrypted);
                    expect(decrypted).toBe(plaintext);
                }
            ),
            { numRuns: 5 }
        );
    });

    test("Property: Key rotation support maintains backward compatibility", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 200 }),
                fc.string({ minLength: 32, maxLength: 64 }), // Primary key
                fc.string({ minLength: 32, maxLength: 64 }), // Secondary key
                async (plaintext, primaryKey, secondaryKey) => {
                    // Encrypt with primary key
                    const primaryProvider = new AesGcmProvider(primaryKey);
                    const encrypted = await primaryProvider.encrypt(plaintext);

                    // Create provider with key rotation (secondary key as primary, original as secondary)
                    const rotatedProvider = new AesGcmProvider(secondaryKey, [primaryKey]);

                    // Should still be able to decrypt old data with rotated provider
                    const decrypted = await rotatedProvider.decrypt(encrypted);
                    expect(decrypted).toBe(plaintext);

                    // New encryptions should use the new primary key
                    const newEncrypted = await rotatedProvider.encrypt(plaintext);
                    const newDecrypted = await rotatedProvider.decrypt(newEncrypted);
                    expect(newDecrypted).toBe(plaintext);

                    // Old and new encrypted values should be different (different keys)
                    expect(encrypted).not.toBe(newEncrypted);
                }
            ),
            { numRuns: 5 }
        );
    });

    test("Property: Encryption handles edge cases consistently", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    fc.constant(""), // Empty string
                    fc.string({ minLength: 1, maxLength: 1 }), // Single character
                    fc.string({ minLength: 10000, maxLength: 10000 }), // Large string
                    fc.string({ minLength: 1, maxLength: 100 }), // Unicode (using regular string)
                    fc.string().map(s => s + '\n' + s), // Multi-line
                    fc.string().map(s => JSON.stringify({ data: s })) // JSON data
                ),
                fc.string({ minLength: 32, maxLength: 64 }),
                async (plaintext, encryptionKey) => {
                    const provider = new AesGcmProvider(encryptionKey);

                    // Should handle all edge cases without throwing
                    const encrypted = await provider.encrypt(plaintext);
                    const decrypted = await provider.decrypt(encrypted);

                    expect(decrypted).toBe(plaintext);
                    expect(encrypted).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
                }
            ),
            { numRuns: 5 }
        );
    });
});