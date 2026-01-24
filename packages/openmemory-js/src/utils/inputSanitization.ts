/**
 * @file Input Sanitization and Validation Utilities
 * Provides comprehensive input validation and sanitization for API endpoints
 */

import { z } from "zod";
import { SecurityError } from "../core/security";

/**
 * SQL injection patterns to detect and prevent
 * More precise patterns to avoid false positives
 */
const SQL_INJECTION_PATTERNS = [
    // SQL keywords with suspicious context (quotes, operators, comments)
    /['"`]\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION)\b/i,
    // SQL comments at end of input
    /(--|\/\*|\*\/)\s*$/,
    // Classic injection patterns with quotes and operators
    /['"`]\s*(OR|AND)\s*['"`]?\d*['"`]?\s*=\s*['"`]?\d*['"`]?/i,
    // UNION-based injection
    /['"`]\s*UNION\s+(ALL\s+)?SELECT/i,
    // SQL functions commonly used in attacks
    /(xp_|sp_|fn_)\w+\s*\(/i,
    // Semicolon followed by SQL keywords
    /;\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE)\b/i,
];

/**
 * XSS patterns to detect and prevent
 */
const XSS_PATTERNS = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
    /javascript\s*:/gi,
    /on\w+\s*=/gi,
    /<[^>]*>/gi, // Simplified: any HTML tag
];

/**
 * Path traversal patterns to detect and prevent
 */
const PATH_TRAVERSAL_PATTERNS = [
    /\.\./,
    /\/\.\./,
    /\.\.\\/,
    /\.\.%2f/i,
    /\.\.%5c/i,
    /%2e%2e/i,
];

/**
 * Command injection patterns to detect and prevent
 * More precise patterns to avoid false positives
 */
const COMMAND_INJECTION_PATTERNS = [
    // Command separators with dangerous commands
    /[;&|]\s*(rm|del|cat|curl|wget|nc|bash|sh|cmd|powershell)\b/i,
    // Backticks and command substitution
    /`[^`]*`/,
    /\$\([^)]*\)/,
    // Multiple command separators (likely malicious)
    /[;&|]{2,}/,
    // Pipe to dangerous commands
    /\|\s*(rm|del|cat|curl|wget|nc|bash|sh|cmd|powershell)\b/i,
];

/**
 * Sanitizes a string by removing potentially dangerous characters
 */
export function sanitizeString(input: string, options: {
    allowHtml?: boolean;
    maxLength?: number;
    stripSql?: boolean;
    stripXss?: boolean;
    stripPathTraversal?: boolean;
    stripCommandInjection?: boolean;
} = {}): string {
    const {
        allowHtml = false,
        maxLength = 10000,
        stripSql = true,
        stripXss = true,
        stripPathTraversal = true,
        stripCommandInjection = true,
    } = options;

    if (typeof input !== 'string') {
        throw new SecurityError("Input must be a string");
    }

    let sanitized = input.trim();

    // Length validation
    if (sanitized.length > maxLength) {
        throw new SecurityError(`Input exceeds maximum length of ${maxLength} characters`);
    }

    // SQL injection detection
    if (stripSql) {
        for (const pattern of SQL_INJECTION_PATTERNS) {
            if (pattern.test(sanitized)) {
                throw new SecurityError("Potential SQL injection detected");
            }
        }
    }

    // XSS detection
    if (stripXss && !allowHtml) {
        for (const pattern of XSS_PATTERNS) {
            if (pattern.test(sanitized)) {
                throw new SecurityError("Potential XSS attack detected");
            }
        }
        // Basic HTML entity encoding for safety
        sanitized = sanitized
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    }

    // Path traversal detection
    if (stripPathTraversal) {
        for (const pattern of PATH_TRAVERSAL_PATTERNS) {
            if (pattern.test(sanitized)) {
                throw new SecurityError("Potential path traversal detected");
            }
        }
    }

    // Command injection detection
    if (stripCommandInjection) {
        for (const pattern of COMMAND_INJECTION_PATTERNS) {
            if (pattern.test(sanitized)) {
                throw new SecurityError("Potential command injection detected");
            }
        }
    }

    return sanitized;
}

/**
 * Validates and sanitizes user ID input
 */
export function sanitizeUserId(userId: string | null | undefined): string | null {
    if (!userId) return null;
    
    const sanitized = sanitizeString(userId, {
        maxLength: 255,
        allowHtml: false,
        stripSql: true,
        stripXss: true,
        stripPathTraversal: true,
        stripCommandInjection: true,
    });

    // Additional validation for user ID format
    if (!/^[a-zA-Z0-9_\-@.]+$/.test(sanitized)) {
        throw new SecurityError("Invalid user ID format. Only alphanumeric characters, underscores, hyphens, @ and dots are allowed");
    }

    return sanitized;
}

/**
 * Validates and sanitizes content input
 */
export function sanitizeContent(content: string, maxLength: number = 50000): string {
    return sanitizeString(content, {
        maxLength,
        allowHtml: false,
        stripSql: true,
        stripXss: true,
        stripPathTraversal: false, // Content might legitimately contain paths
        stripCommandInjection: true,
    });
}

/**
 * Validates and sanitizes metadata object
 */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    if (!metadata || typeof metadata !== 'object') {
        return {};
    }

    const sanitized: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(metadata)) {
        // Sanitize key
        const sanitizedKey = sanitizeString(key, {
            maxLength: 255,
            allowHtml: false,
            stripSql: true,
            stripXss: true,
            stripPathTraversal: true,
            stripCommandInjection: true,
        });

        // Sanitize value based on type
        if (typeof value === 'string') {
            sanitized[sanitizedKey] = sanitizeString(value, {
                maxLength: 10000,
                allowHtml: false,
                stripSql: true,
                stripXss: true,
                stripPathTraversal: false,
                stripCommandInjection: true,
            });
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            sanitized[sanitizedKey] = value;
        } else if (value === null || value === undefined) {
            sanitized[sanitizedKey] = value;
        } else {
            // For complex objects, convert to string and sanitize
            sanitized[sanitizedKey] = sanitizeString(JSON.stringify(value), {
                maxLength: 10000,
                allowHtml: false,
                stripSql: true,
                stripXss: true,
                stripPathTraversal: false,
                stripCommandInjection: true,
            });
        }
    }

    return sanitized;
}

/**
 * Validates and sanitizes tags array
 */
export function sanitizeTags(tags: string[]): string[] {
    if (!Array.isArray(tags)) {
        return [];
    }

    return tags
        .filter(tag => typeof tag === 'string')
        .map(tag => sanitizeString(tag, {
            maxLength: 100,
            allowHtml: false,
            stripSql: true,
            stripXss: true,
            stripPathTraversal: true,
            stripCommandInjection: true,
        }))
        .filter(tag => tag.length > 0)
        .slice(0, 50); // Limit number of tags
}

/**
 * Enhanced Zod schema for user ID validation
 */
export const UserIdValidationSchema = z.string()
    .min(1, "User ID cannot be empty")
    .max(255, "User ID too long")
    .regex(/^[a-zA-Z0-9_\-@.]+$/, "Invalid user ID format")
    .transform(sanitizeUserId);

/**
 * Enhanced Zod schema for content validation
 */
export const ContentValidationSchema = z.string()
    .min(1, "Content cannot be empty")
    .max(50000, "Content too long")
    .refine(content => content.trim().length > 0, "Content cannot be only whitespace")
    .transform(sanitizeContent);

/**
 * Enhanced Zod schema for metadata validation
 */
export const MetadataValidationSchema = z.record(z.unknown())
    .optional()
    .default({})
    .transform(sanitizeMetadata);

/**
 * Enhanced Zod schema for tags validation
 */
export const TagsValidationSchema = z.array(z.string())
    .optional()
    .default([])
    .transform(sanitizeTags);

/**
 * Rate limiting helper to detect suspicious patterns
 */
export function detectSuspiciousActivity(input: string): boolean {
    // Check for repeated patterns that might indicate automated attacks
    const repeatedPatterns = [
        /(.{1,10})\1{10,}/g, // Same pattern repeated 10+ times
        /[<>]{5,}/g, // Multiple angle brackets
        /['"`]{5,}/g, // Multiple quotes
        /[;|&$]{3,}/g, // Multiple command separators
    ];

    return repeatedPatterns.some(pattern => pattern.test(input));
}

/**
 * Comprehensive input validation middleware factory
 */
export function createInputValidator<T>(schema: z.ZodSchema<T>) {
    return (input: unknown): T => {
        try {
            // Pre-validation security checks for string inputs
            if (typeof input === 'string' && detectSuspiciousActivity(input)) {
                throw new SecurityError("Suspicious input pattern detected");
            }

            // Validate with Zod schema
            const result = schema.parse(input);
            return result;
        } catch (error) {
            if (error instanceof z.ZodError) {
                throw new SecurityError(`Input validation failed: ${error.errors.map(e => e.message).join(', ')}`);
            }
            throw error;
        }
    };
}