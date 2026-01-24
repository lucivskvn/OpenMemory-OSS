/**
 * @file Setup Token Manager
 * Handles temporary setup tokens for initial system configuration
 */
import { logger } from "../utils/logger";
import { env } from "../core/cfg";

interface SetupToken {
    token: string;
    expiresAt: number;
    used: boolean;
}

class SetupTokenManager {
    private tokens = new Map<string, SetupToken>();
    private readonly TOKEN_LIFETIME = 5 * 60 * 1000; // 5 minutes

    /**
     * Generate a new setup token
     */
    generateToken(): string {
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + this.TOKEN_LIFETIME;
        
        this.tokens.set(token, {
            token,
            expiresAt,
            used: false
        });

        // Clean up expired tokens
        this.cleanupExpiredTokens();

        logger.info(`[SETUP] Generated setup token: ${token.slice(0, 8)}...`);
        return token;
    }

    /**
     * Validate and consume a setup token
     */
    validateToken(token: string): boolean {
        const setupToken = this.tokens.get(token);
        
        if (!setupToken) {
            logger.warn(`[SETUP] Invalid token attempted: ${token.slice(0, 8)}...`);
            return false;
        }

        if (setupToken.used) {
            logger.warn(`[SETUP] Already used token attempted: ${token.slice(0, 8)}...`);
            return false;
        }

        if (Date.now() > setupToken.expiresAt) {
            logger.warn(`[SETUP] Expired token attempted: ${token.slice(0, 8)}...`);
            this.tokens.delete(token);
            return false;
        }

        // Mark as used
        setupToken.used = true;
        logger.info(`[SETUP] Token validated and consumed: ${token.slice(0, 8)}...`);
        return true;
    }

    /**
     * Check if setup is required (no admin key configured)
     */
    isSetupRequired(): boolean {
        return !env.adminKey || env.adminKey === "";
    }

    /**
     * Clean up expired tokens
     */
    private cleanupExpiredTokens(): void {
        const now = Date.now();
        for (const [token, setupToken] of this.tokens.entries()) {
            if (now > setupToken.expiresAt) {
                this.tokens.delete(token);
            }
        }
    }

    /**
     * Get all active tokens (for testing)
     */
    getActiveTokens(): string[] {
        this.cleanupExpiredTokens();
        return Array.from(this.tokens.keys()).filter(token => !this.tokens.get(token)?.used);
    }

    /**
     * Clear all tokens (for testing)
     */
    clearAllTokens(): void {
        this.tokens.clear();
        logger.info("[SETUP] All tokens cleared");
    }
}

// Export singleton instance
export const setupTokenManager = new SetupTokenManager();

// Export class for testing
export { SetupTokenManager };