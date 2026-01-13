/**
 * @file Core utility functions for OpenMemory.
 */
export const now = (): number => Date.now();
export const rid = (): string => globalThis.crypto.randomUUID();
export const stringifyJSON = JSON.stringify;
export const parseJSON = <T = unknown>(x: string): T => JSON.parse(x);

// End of utils

export const safeDate = (d: string | number | undefined): Date | undefined => {
    if (d === undefined) return undefined;
    const date = new Date(d);
    if (isNaN(date.getTime())) {
        return undefined;
    }
    return date;
};

export * from "./retry";

export const normalizeUserId = (
    userId?: string | null,
): string | null | undefined => {
    if (userId === undefined) return undefined;
    if (userId === null) return null;
    const trimmed = userId.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "anonymous") {
        return null;
    }
    // "system" is also null (anonymous/system context) unless we want it to be undefined.
    // Given our convention, undefined is "Any/System", so "system" string should probably be undefined
    // to allow a user to explicitly pass "system" to mean "Any".
    if (trimmed.toLowerCase() === "system") return undefined;
    return trimmed;
};

/**
 * Base64 encoding helper (Web Crypto compatible).
 */
export const toBase64 = (buffer: ArrayBuffer | Uint8Array): string => {
    // In Node.js, we can use Buffer for better performance, but falling back to btoa for standard compliancy
    if (typeof Buffer !== "undefined") {
        return Buffer.from(buffer).toString("base64");
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
