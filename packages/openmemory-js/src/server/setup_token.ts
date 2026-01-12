
let _setupToken: string | null = null;

export const setupTokenManager = {
    /**
     * Generates a new random setup token.
     * Only works if one isn't already active (or overwrites it? simpler to overwrite).
     */
    generate: (): string => {
        const token = Array.from(
            globalThis.crypto.getRandomValues(new Uint8Array(16)),
        )
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        _setupToken = token;
        return token;
    },

    /**
     * Gets the current active token.
     */
    get: (): string | null => {
        return _setupToken;
    },

    /**
     * Verifies if the provided token matches the active one.
     * If matched, the token is CONSUMED (invalidated).
     */
    verifyAndConsume: (input: string): boolean => {
        if (!_setupToken) return false;
        // Constant-time comparison to be standard, though timing attack on setup token is low risk
        // Simpler check is fine for this context.
        if (input === _setupToken) {
            _setupToken = null; // Consume
            return true;
        }
        return false;
    },

    /**
     * Explicitly clears the token (e.g. if setup is done via other means).
     */
    clear: () => {
        _setupToken = null;
    },
};
