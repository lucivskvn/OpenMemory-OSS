/**
 * @file Core utility functions for OpenMemory.
 */
import { tokenize } from "./text";

/**
 * Returns the current Unix timestamp in milliseconds.
 */
export const now = () => Date.now();

/**
 * Generates a random unique identifier.
 * Uses a cryptographically secure number if available, else falls back to math random.
 */
export const rid = (len = 12): string => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const values = new Uint8Array(len);

    // Attempt secure random if available (Browser/Node)
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(values);
    } else {
        // Fallback for extreme legacy/edge environments
        for (let i = 0; i < len; i++) {
            values[i] = Math.floor(Math.random() * 256);
        }
    }

    let res = "";
    for (let i = 0; i < len; i++) {
        res += chars.charAt(values[i] % chars.length);
    }
    return res;
};

/**
 * Standardized JSON stringification with error handling.
 */
export const stringifyJSON = (obj: unknown, fb = "{}"): string => {
    try {
        return JSON.stringify(obj);
    } catch (e) {
        safeLog("error", "Failed to stringify JSON", { error: e });
        return fb;
    }
};
export const parseJSON = <T = unknown>(x: unknown): T => {
    if (typeof x !== "string") return x as T;
    try {
        return JSON.parse(x) as T;
    } catch {
        return x as unknown as T;
    }
};


export const safeDate = (d: string | number | undefined): Date | undefined => {
    if (d === undefined) return undefined;
    // Handle numeric strings (e.g. "1715694857476" from query params)
    if (typeof d === "string" && /^\d+$/.test(d)) {
        d = parseInt(d, 10);
    }
    const date = new Date(d);
    if (isNaN(date.getTime())) {
        return undefined;
    }
    return date;
};

/**
 * Safe logging helper that falls back to console when logger is unavailable.
 * Attempts to use the structured logger if available, otherwise falls back to console.
 */
export const safeLog = (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => {
    try {
        // Try to use structured logger dynamically to avoid circular deps
        const logFn = console[level] || console.log;
        logFn(`[${level.toUpperCase()}] ${msg}`, meta !== undefined ? meta : "");
    } catch {
        // Ignore logging errors during extreme edge cases
    }
};

export * from "./retry";

export const normalizeUserId = (userId: string | null | undefined): string | null | undefined => {
    if (userId === undefined) return undefined;
    if (userId === null || userId === "" || userId === "anonymous" || userId === "public" || userId === "NULL") return null;
    const trimmed = userId.trim();

    // "system" is treated as undefined (Any/System context)
    if (trimmed.toLowerCase() === "system") return undefined;
    return trimmed;
};

/**
 * Base64 encoding helper (Web Crypto compatible).
 */
export const toBase64 = (buffer: ArrayBuffer | Uint8Array): string => {
    // In Node.js, we can use Buffer for better performance, but falling back to btoa for standard compliancy
    if (typeof Buffer !== "undefined") {
        // Handle both ArrayBuffer and Uint8Array safely for Buffer.from
        const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        return Buffer.from(buf).toString("base64");
    }
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
};

/**
 * Base64 decoding helper (Web Crypto compatible).
 */
export const fromBase64 = (base64: string): Uint8Array => {
    if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(base64, "base64"));
    }
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

/**
 * Convert ArrayBuffer/Uint8Array to Hex string (Web Crypto compatible).
 */
export const toHex = (buffer: ArrayBuffer | Uint8Array): string => {
    if (typeof Buffer !== "undefined") {
        return Buffer.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)).toString("hex");
    }
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
};

/**
 * Jaccard similarity between two strings based on tokens.
 */
export const calculateSimilarity = (text1: string, text2: string): number => {
    const set1 = new Set(tokenize(text1));
    const set2 = new Set(tokenize(text2));
    if (set1.size === 0 || set2.size === 0) return 0;

    let intersectionCount = 0;
    for (const token of set1) {
        if (set2.has(token)) intersectionCount++;
    }
    const unionSize = new Set([...set1, ...set2]).size;
    return unionSize > 0 ? intersectionCount / unionSize : 0;
};
