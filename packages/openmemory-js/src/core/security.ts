/**
 * @file Security module for OpenMemory.
 * Handles encryption-at-rest, key derivation (AES-256-GCM), and security boundary management.
 */
import { now, fromBase64, toBase64 } from "../utils";
import { logger } from "../utils/logger";
import { env, reloadConfig } from "./cfg";

/**
 * Custom error class for security-related failures.
 */
export class SecurityError extends Error {
    constructor(
        message: string,
        public readonly originalError?: unknown,
    ) {
        super(message);
        this.name = "SecurityError";
    }
}

/**
 * Interface for encryption providers.
 * Allows pluggable security implementations (e.g., KMS, Vault, Local AES).
 */
export interface EncryptionProvider {
    encrypt(plaintext: string): Promise<string>;
    decrypt(ciphertext: string): Promise<string>;
}

/**
 * No-op provider for when encryption is disabled.
 */
export class NoopProvider implements EncryptionProvider {
    async encrypt(plaintext: string): Promise<string> {
        return plaintext;
    }
    async decrypt(ciphertext: string): Promise<string> {
        return ciphertext;
    }
}

/**
 * AES-256-GCM implementation using SubtleCrypto.
 * Keys are stretched from secrets using PBKDF2 with 100k iterations.
 */
export class AesGcmProvider implements EncryptionProvider {
    private keyCache = new Map<string, CryptoKey>();
    private readonly ALGO = "AES-GCM";
    private readonly IV_LEN = 12; // 96 bits

    constructor(
        private primarySecret: string,
        private secondarySecrets: string[] = [],
    ) {
        if (!primarySecret || primarySecret.length < 16) {
            throw new Error(
                "Primary encryption secret must be at least 16 characters.",
            );
        }
    }

    /**
     * Derives a cryptographic key from a secret string using PBKDF2.
     * @param secret - The raw secret string.
     * @returns A Promise resolving to the CryptoKey.
     */
    private async getKey(secret: string): Promise<CryptoKey> {
        if (this.keyCache.has(secret)) return this.keyCache.get(secret)!;

        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            enc.encode(secret),
            { name: "PBKDF2" },
            false,
            ["deriveKey"],
        );

        const key = await crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: enc.encode(env.encryptionSalt),
                iterations: 600000,
                hash: "SHA-256",
            },
            keyMaterial,
            { name: this.ALGO, length: 256 },
            false,
            ["encrypt", "decrypt"],
        );
        this.keyCache.set(secret, key);
        return key;
    }

    /**
     * Encrypts plaintext using AES-GCM with the primary key.
     * @param plaintext - The string to encrypt.
     * @returns The ciphertext in format `v1:ivB64:contentB64`.
     * @throws {SecurityError} If encryption fails.
     */
    async encrypt(plaintext: string): Promise<string> {
        try {
            const key = await this.getKey(this.primarySecret);
            const iv = crypto.getRandomValues(new Uint8Array(this.IV_LEN));
            const enc = new TextEncoder();

            const encrypted = await crypto.subtle.encrypt(
                { name: this.ALGO, iv },
                key,
                enc.encode(plaintext),
            );

            // Serialization: v1:iv:ciphertext in base64
            const ivB64 = toBase64(iv);
            const contentB64 = toBase64(encrypted);
            return `v1:${ivB64}:${contentB64}`;
        } catch (e) {
            const { getContext } = await import("./context");
            const ctx = getContext();
            logger.error("[Security] Encryption failed:", { error: e, rid: ctx?.requestId });
            throw new SecurityError("Encryption failed", e);
        }
    }

    /**
     * Decrypts ciphertext using AES-GCM.
     * Attempts decryption with the primary key, then falls back to secondary keys (rotation support).
     * @param ciphertext - The string to decrypt.
     * @returns The decrypted plaintext.
     * @throws {SecurityError} If decryption fails with all available keys.
     */
    async decrypt(ciphertext: string): Promise<string> {
        // Support legacy "enc:" prefix and current "v1:" prefix
        if (!ciphertext.startsWith("v1:") && !ciphertext.startsWith("enc:")) {
            return ciphertext;
        }

        const parts = ciphertext.split(":");
        if (parts.length !== 3) {
            throw new SecurityError("Invalid ciphertext format");
        }

        const iv = fromBase64(parts[1]);
        const content = fromBase64(parts[2]);
        const allSecrets = [this.primarySecret, ...this.secondarySecrets];

        for (const secret of allSecrets) {
            try {
                const key = await this.getKey(secret);
                const decent = await crypto.subtle.decrypt(
                    { name: this.ALGO, iv: iv as unknown as BufferSource },
                    key,
                    content as unknown as BufferSource,
                );
                return new TextDecoder().decode(decent);
            } catch {
                // Try next key if decryption fails (e.g. wrong key during rotation)
                continue;
            }
        }

        const { getContext } = await import("./context");
        const ctx = getContext();
        logger.error("[Security] Decryption failed with all available keys.", { rid: ctx?.requestId });
        throw new SecurityError("Decryption failed. No valid keys found.");
    }

    /**
     * Verifies that the primary key is functional.
     */
    async verifyKey(): Promise<boolean> {
        try {
            const testPayload = "om_security_check_" + now();
            const encrypted = await this.encrypt(testPayload);
            const decrypted = await this.decrypt(encrypted);
            return decrypted === testPayload;
        } catch (e) {
            logger.error("[Security] Key verification failed:", { error: e });
            return false;
        }
    }
}

let providerInstance: EncryptionProvider | null = null;

/**
 * Retrieves the singleton encryption provider based on environment configuration.
 */
export const getEncryption = (): EncryptionProvider => {
    if (providerInstance) return providerInstance;

    const secret = env.encryptionKey || env.apiKey;
    const secondarySecrets = env.encryptionSecondaryKeys || [];
    const enabled = env.encryptionEnabled;

    if (enabled && secret) {
        providerInstance = new AesGcmProvider(secret, secondarySecrets);
        logger.info("[Security] 🔒 Encryption-at-Rest ENABLED (AES-256-GCM)");
        if (secondarySecrets.length > 0) {
            logger.info(
                `[Security] Rotation support active (${secondarySecrets.length} secondary keys)`,
            );
        }
    } else {
        providerInstance = new NoopProvider();
        if (enabled && !secret) {
            logger.warn(
                "[Security] ⚠️ Encryption enabled but no key found. Falling back to plaintext.",
            );
        }
    }
    return providerInstance;
};

/**
 * Resets the encryption provider instance (primarily for configuration refresh or testing).
 */
export const resetSecurity = () => {
    reloadConfig();
    providerInstance = null;
};
