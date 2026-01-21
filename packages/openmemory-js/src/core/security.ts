/**
 * @file Security module for OpenMemory.
 * Handles encryption-at-rest, key derivation (AES-256-GCM), and security boundary management.
 */
import { now, fromBase64, toBase64 } from "../utils";
import { logger } from "../utils/logger";
import { env, reloadConfig } from "./cfg";
import { getContext } from "./context";

// Use global crypto (Web Crypto API), supported natively by Bun and modern Node.js
const webCrypto = globalThis.crypto;

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
    verifyKey(): Promise<boolean>;
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
    async verifyKey(): Promise<boolean> {
        return true;
    }
}

/**
 * Validates a table name to prevent SQL injection.
 * STRICT: Only allows alphanumeric characters and underscores [a-zA-Z0-9_].
 *
 * @param name - The table name to validate.
 * @returns The validated table name.
 * @throws {SecurityError} If the name contains invalid characters.
 */
export function validateTableName(name: string): string {
    if (!name) return name;
    // Strict validation: [a-zA-Z0-9_]
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
        throw new SecurityError(`Invalid table name: "${name}". Only alphanumeric and underscore allowed.`);
    }
    return name;
}


/**
 * AES-256-GCM implementation using SubtleCrypto.
 * Keys are stretched from secrets using PBKDF2 with 600k iterations.
 * Includes key caching with TTL for performance.
 */
interface CachedKey {
    key: CryptoKey;
    createdAt: number;
}

export class AesGcmProvider implements EncryptionProvider {
    private keyCache = new Map<string, CachedKey>();
    private readonly ALGO = "AES-GCM";
    private readonly IV_LEN = 12; // 96 bits
    private readonly CACHE_TTL = 60 * 60 * 1000; // 1 Hour

    constructor(
        private primarySecret: string,
        private secondarySecrets: string[] = [],
    ) {
        if (!primarySecret || primarySecret.length < 32) {
            throw new Error(
                "Primary encryption secret must be at least 32 characters for AES-256 security.",
            );
        }
    }

    /**
     * Derives a cryptographic key from a secret string using PBKDF2.
     * @param secret - The raw secret string.
     * @returns A Promise resolving to the CryptoKey.
     */
    private async getKey(secret: string): Promise<CryptoKey> {
        const nowMs = Date.now();
        const cached = this.keyCache.get(secret);

        if (cached && (nowMs - cached.createdAt < this.CACHE_TTL)) {
            return cached.key;
        }

        const enc = new TextEncoder();
        const keyMaterial = await webCrypto.subtle.importKey(
            "raw",
            enc.encode(secret),
            { name: "PBKDF2" },
            false,
            ["deriveKey"],
        );

        const saltVal = env.encryptionSalt || "openmemory-default-salt";
        // Warn if using default salt in production? 
        // cfg.ts validates against "openmemory-salt-v1" but we fallback here just in case.

        const key = await webCrypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: enc.encode(saltVal),
                iterations: 600000,
                hash: "SHA-256",
            },
            keyMaterial,
            { name: this.ALGO, length: 256 },
            false,
            ["encrypt", "decrypt"],
        );

        // Cache with timestamp
        this.keyCache.set(secret, { key, createdAt: nowMs });

        // Cleanup old entries
        for (const [k, v] of this.keyCache.entries()) {
            if ((nowMs - v.createdAt) > this.CACHE_TTL) {
                this.keyCache.delete(k);
            }
        }

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
            const iv = webCrypto.getRandomValues(new Uint8Array(this.IV_LEN));
            const enc = new TextEncoder();

            const encrypted = await webCrypto.subtle.encrypt(
                { name: this.ALGO, iv },
                key,
                enc.encode(plaintext),
            );

            // Serialization: v1:iv:ciphertext in base64
            const ivB64 = toBase64(iv);
            // ArrayBuffer to Uint8Array cast required for strict TS with helper
            const contentB64 = toBase64(new Uint8Array(encrypted));
            return `v1:${ivB64}:${contentB64}`;
        } catch (e) {
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
                const decent = await webCrypto.subtle.decrypt(
                    { name: this.ALGO, iv: iv as any },
                    key,
                    content as any,
                );
                return new TextDecoder().decode(decent);
            } catch {
                // Try next key if decryption fails (e.g. wrong key during rotation)
                continue;
            }
        }

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

    const secret = env.encryptionKey || env.apiKey; // Fallback to API Key only for NON-PROD convenience if explicit key missing
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
            // CRITICAL: In production, do not allow silent fallback to plaintext if encryption was requested
            if (env.isProd) {
                logger.error("[Security] 🚨 FATAL: Encryption enabled (OM_ENCRYPTION_ENABLED=true) but no keys found!");
                logger.error("[Security] You must set OM_ENCRYPTION_KEY.");
                throw new Error("Security Misconfiguration: Encryption enabled but no keys provided in Production.");
            }
            logger.warn(
                "[Security] ⚠️ Encryption enabled but no key found. Falling back to plaintext (Non-Prod Mode).",
            );
        }
    }
    return providerInstance!;
};

/**
 * Resets the encryption provider instance (primarily for configuration refresh or testing).
 */
export const resetSecurity = () => {
    reloadConfig();
    providerInstance = null;
};

/**
 * Service object for Security operations.
 * Use this for better testability (mocking).
 */
export const Security = {
    getEncryption,
    resetSecurity,
};
