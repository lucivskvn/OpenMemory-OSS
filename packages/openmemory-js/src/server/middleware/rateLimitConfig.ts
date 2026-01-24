/**
 * @file Rate Limiting Configuration
 * Provides endpoint-specific rate limiting configurations
 */

import { env } from "../../core/cfg";

/**
 * Rate limiting configuration for different endpoint types
 */
export interface RateLimitConfig {
    windowMs: number;
    max: number;
    keyPrefix: string;
    message?: string;
    skipSuccessfulRequests?: boolean;
    skipFailedRequests?: boolean;
}

/**
 * Default rate limiting configurations for different endpoint categories
 */
export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
    // Global default - moderate limits for general API usage
    global: {
        windowMs: env.rateLimitWindowMs || 60000, // 1 minute
        max: env.rateLimitMaxRequests || 100, // 100 requests per minute
        keyPrefix: "global",
        message: "Too many requests. Please try again later.",
    },

    // Authentication endpoints - stricter limits to prevent brute force
    auth: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 5, // 5 attempts per 15 minutes
        keyPrefix: "auth",
        message: "Too many authentication attempts. Please try again in 15 minutes.",
        skipSuccessfulRequests: true, // Don't count successful logins
    },

    // Admin endpoints - very strict limits for sensitive operations
    admin: {
        windowMs: 60000, // 1 minute
        max: 20, // 20 requests per minute
        keyPrefix: "admin",
        message: "Too many admin requests. Please try again later.",
    },

    // Memory operations - moderate limits for core functionality
    memory: {
        windowMs: 60000, // 1 minute
        max: 200, // 200 requests per minute
        keyPrefix: "memory",
        message: "Too many memory operations. Please try again later.",
    },

    // Search operations - higher limits for read operations
    search: {
        windowMs: 60000, // 1 minute
        max: 300, // 300 requests per minute
        keyPrefix: "search",
        message: "Too many search requests. Please try again later.",
    },

    // Upload/ingestion endpoints - lower limits for resource-intensive operations
    upload: {
        windowMs: 60000, // 1 minute
        max: 10, // 10 uploads per minute
        keyPrefix: "upload",
        message: "Too many upload requests. Please try again later.",
    },

    // Webhook endpoints - moderate limits
    webhook: {
        windowMs: 60000, // 1 minute
        max: 50, // 50 requests per minute
        keyPrefix: "webhook",
        message: "Too many webhook requests. Please try again later.",
    },

    // Setup/configuration endpoints - very strict limits
    setup: {
        windowMs: 5 * 60 * 1000, // 5 minutes
        max: 3, // 3 requests per 5 minutes
        keyPrefix: "setup",
        message: "Too many setup requests. Please try again in 5 minutes.",
    },

    // Dashboard/UI endpoints - higher limits for user interface
    dashboard: {
        windowMs: 60000, // 1 minute
        max: 500, // 500 requests per minute
        keyPrefix: "dashboard",
        message: "Too many dashboard requests. Please try again later.",
    },

    // Health check endpoints - very high limits
    health: {
        windowMs: 60000, // 1 minute
        max: 1000, // 1000 requests per minute
        keyPrefix: "health",
        message: "Too many health check requests. Please try again later.",
    },
};

/**
 * Get rate limit configuration for a specific endpoint type
 */
export function getRateLimitConfig(type: keyof typeof RATE_LIMIT_CONFIGS): RateLimitConfig {
    return RATE_LIMIT_CONFIGS[type] || RATE_LIMIT_CONFIGS.global;
}

/**
 * Create a rate limit configuration with custom overrides
 */
export function createRateLimitConfig(
    type: keyof typeof RATE_LIMIT_CONFIGS,
    overrides: Partial<RateLimitConfig> = {}
): RateLimitConfig {
    const baseConfig = getRateLimitConfig(type);
    return {
        ...baseConfig,
        ...overrides,
    };
}

/**
 * Rate limiting presets for common scenarios
 */
export const RATE_LIMIT_PRESETS = {
    // Very strict - for sensitive operations
    strict: {
        windowMs: 60000,
        max: 5,
        keyPrefix: "strict",
    },

    // Moderate - for normal API operations
    moderate: {
        windowMs: 60000,
        max: 100,
        keyPrefix: "moderate",
    },

    // Lenient - for read-heavy operations
    lenient: {
        windowMs: 60000,
        max: 500,
        keyPrefix: "lenient",
    },

    // Burst - for UI/dashboard operations
    burst: {
        windowMs: 60000,
        max: 1000,
        keyPrefix: "burst",
    },
} as const;