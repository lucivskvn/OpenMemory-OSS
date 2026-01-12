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
