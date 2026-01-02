import { env } from "./cfg";

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
export class NoOpProvider implements EncryptionProvider {
    async encrypt(plaintext: string): Promise<string> { return plaintext; }
    async decrypt(ciphertext: string): Promise<string> { return ciphertext; }
}

/**
 * AES-256-GCM implementation using Node/Bun crypto.
 * Keys are derived from the configured API Key or a specific SECRET_KEY.
 */
export class AesGcmProvider implements EncryptionProvider {
    private keyVal: CryptoKey | null = null;
    private readonly ALGO = "AES-GCM";
    private readonly IV_LEN = 12; // 96 bits

    constructor(private secret: string) {
        if (!secret || secret.length < 16) {
            throw new Error("Encryption secret must be at least 16 characters.");
        }
    }

    private async getKey(): Promise<CryptoKey> {
        if (this.keyVal) return this.keyVal;

        // Use PBKDF2 to derive a strong key from the secret string
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            enc.encode(this.secret),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );

        this.keyVal = await crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: enc.encode("openmemory-salt-v1"), // Fixed salt for determinism (consider randomizing if key rotation is added)
                iterations: 100000,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: this.ALGO, length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
        return this.keyVal;
    }

    async encrypt(plaintext: string): Promise<string> {
        const key = await this.getKey();
        const iv = crypto.getRandomValues(new Uint8Array(this.IV_LEN));
        const enc = new TextEncoder();

        const encrypted = await crypto.subtle.encrypt(
            { name: this.ALGO, iv },
            key,
            enc.encode(plaintext)
        );

        // serialize: iv:ciphertext in base64
        const ivB64 = Buffer.from(iv).toString('base64');
        const contentB64 = Buffer.from(encrypted).toString('base64');
        return `enc:${ivB64}:${contentB64}`;
    }

    async decrypt(ciphertext: string): Promise<string> {
        if (!ciphertext.startsWith("enc:")) return ciphertext; // Migration path: allow unencrypted

        const parts = ciphertext.split(":");
        if (parts.length !== 3) throw new Error("Invalid ciphertext format");

        const key = await this.getKey();
        const iv = Buffer.from(parts[1], 'base64');
        const content = Buffer.from(parts[2], 'base64');

        try {
            const decent = await crypto.subtle.decrypt(
                { name: this.ALGO, iv },
                key,
                content
            );
            return new TextDecoder().decode(decent);
        } catch (e: unknown) {
            console.error("Decryption failed:", e);
            throw new Error("Decryption failed. Check key consistency.");
        }
    }
}

let instance: EncryptionProvider | null = null;

export const get_encryption = (): EncryptionProvider => {
    if (instance) return instance;

    // Use OM_ENCRYPTION_KEY if set, otherwise fallback to API Key (not ideal but better than nothing for demo)
    // If neither, no encryption.
    const secret = process.env.OM_ENCRYPTION_KEY || process.env.OM_API_KEY;
    const enabled = process.env.OM_ENCRYPTION_ENABLED === "true";

    if (enabled && secret) {
        instance = new AesGcmProvider(secret);
        console.log("[SECURITY] 🔒 Encryption-at-Rest ENABLED (AES-256-GCM)");
    } else {
        instance = new NoOpProvider();
        if (enabled && !secret) {
            console.warn("[SECURITY] ⚠️ Encryption enabled but no key found. Falling back to plaintext.");
        }
    }
    return instance;
};

export const reset_security = () => {
    instance = null;
};
