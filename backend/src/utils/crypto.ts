import { CryptoHasher } from "bun";

/**
 * Bun-native cryptographic utilities
 * Centralizes password hashing, verification, and fast hashing helpers.
 */

export async function hashPassword(password: string): Promise<string> {
    // Use recommended Argon2id parameters for interactive logins / API keys
    // These parameters are conservative; tune if necessary for CI/hardware.
    return await Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: 19456,
        timeCost: 2,
    });
}

export async function verifyPassword(
    password: string,
    hash: string,
): Promise<boolean> {
    return await Bun.password.verify(password, hash);
}

export function hashString(
    input: string,
    algorithm: "sha256" | "sha512" = "sha256",
): string {
    const h = new CryptoHasher(algorithm);
    h.update(input);
    return h.digest("hex");
}

export function hashBuffer(
    input: Uint8Array,
    algorithm: "sha256" | "sha512" = "sha256",
): string {
    const h = new CryptoHasher(algorithm);
    h.update(input);
    return h.digest("hex");
}

export function generateId(): string {
    return crypto.randomUUID();
}

export function generateToken(bytes: number = 32): string {
    const arr = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(arr)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

export function isHashedKey(key: string): boolean {
    if (!key || typeof key !== "string") return false;
    // Match Argon2 variants explicitly: $argon2id$, $argon2i$, $argon2d$
    const argon2Re = /^\$argon2(?:id|i|d)\$/i;
    const bcryptRe = /^\$2(?:a|b|y)\$/i;
    if (argon2Re.test(key) || bcryptRe.test(key)) return true;
    // Future-proof: if other well-known hash formats are needed, add them explicitly.
    return false;
}

// Placeholder secrets management helpers for future Bun.secrets integration
export async function storeSecret(_k: string, _v: string): Promise<void> {
    // Not implemented: platform-specific Bun.secrets or vault integration
    return Promise.resolve();
}

export async function retrieveSecret(_k: string): Promise<string | null> {
    return Promise.resolve(null);
}

export function generateCSRFToken(): string {
    // Simple CSRF token generator - timing-safe verify provided separately
    return generateToken(24);
}

export function verifyCSRFToken(token: string, expected: string): boolean {
    // timing-safe comparison
    if (token.length !== expected.length) return false;
    let res = 0;
    for (let i = 0; i < token.length; i++)
        res |= token.charCodeAt(i) ^ expected.charCodeAt(i);
    return res === 0;
}
