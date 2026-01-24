/**
 * @file Standardized Error Utilities
 * Provides consistent error handling patterns across the OpenMemory codebase.
 * Follows the existing AppError pattern from server/errors.ts but extends it for broader use.
 */

import { AppError } from "../server/errors";

/**
 * Standard error codes used throughout the application
 */
export const ErrorCodes = {
    // Validation Errors (400-499)
    INVALID_INPUT: "INVALID_INPUT",
    MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
    INVALID_FORMAT: "INVALID_FORMAT",
    FILE_TOO_LARGE: "FILE_TOO_LARGE",
    UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
    
    // Authentication/Authorization Errors (401-403)
    AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
    INVALID_API_KEY: "INVALID_API_KEY",
    INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",
    
    // Resource Errors (404-409)
    RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
    RESOURCE_CONFLICT: "RESOURCE_CONFLICT",
    
    // Processing Errors (422)
    PROCESSING_FAILED: "PROCESSING_FAILED",
    EXTRACTION_FAILED: "EXTRACTION_FAILED",
    INGESTION_FAILED: "INGESTION_FAILED",
    
    // Rate Limiting (429)
    RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
    
    // Server Errors (500-599)
    INTERNAL_ERROR: "INTERNAL_ERROR",
    SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    TIMEOUT: "TIMEOUT",
    CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
    DATABASE_ERROR: "DATABASE_ERROR",
    EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Creates a standardized validation error
 */
export const createValidationError = (message: string, details?: unknown): AppError => {
    return new AppError(400, ErrorCodes.INVALID_INPUT, message, details);
};

/**
 * Creates a standardized authentication error
 */
export const createAuthError = (message: string = "Authentication required"): AppError => {
    return new AppError(401, ErrorCodes.AUTHENTICATION_REQUIRED, message);
};

/**
 * Creates a standardized authorization error
 */
export const createAuthorizationError = (message: string = "Invalid API Key"): AppError => {
    return new AppError(403, ErrorCodes.INVALID_API_KEY, message);
};

/**
 * Creates a standardized not found error
 */
export const createNotFoundError = (resource: string): AppError => {
    return new AppError(404, ErrorCodes.RESOURCE_NOT_FOUND, `${resource} not found`);
};

/**
 * Creates a standardized processing error
 */
export const createProcessingError = (operation: string, details?: unknown): AppError => {
    return new AppError(422, ErrorCodes.PROCESSING_FAILED, `${operation} failed`, details);
};

/**
 * Creates a standardized file size error
 */
export const createFileSizeError = (fileType: string, actualSize: number, maxSize: number): AppError => {
    const actualMB = (actualSize / 1024 / 1024).toFixed(2);
    const maxMB = (maxSize / 1024 / 1024).toFixed(2);
    return new AppError(
        413, 
        ErrorCodes.FILE_TOO_LARGE, 
        `${fileType} file too large: ${actualMB}MB. Limit is ${maxMB}MB.`,
        { actualSize, maxSize }
    );
};

/**
 * Creates a standardized unsupported type error
 */
export const createUnsupportedTypeError = (type: string): AppError => {
    return new AppError(415, ErrorCodes.UNSUPPORTED_TYPE, `Unsupported content type: ${type}`);
};

/**
 * Creates a standardized configuration error
 */
export const createConfigError = (message: string): AppError => {
    return new AppError(500, ErrorCodes.CONFIGURATION_ERROR, message);
};

/**
 * Creates a standardized timeout error
 */
export const createTimeoutError = (operation: string): AppError => {
    return new AppError(408, ErrorCodes.TIMEOUT, `${operation} timeout exceeded`);
};

/**
 * Creates a standardized external service error
 */
export const createExternalServiceError = (service: string, status: number, message: string): AppError => {
    return new AppError(502, ErrorCodes.EXTERNAL_SERVICE_ERROR, `${service} error: ${message}`, { status });
};

/**
 * Wraps an unknown error into a standardized AppError
 */
export const wrapError = (error: unknown, operation: string): AppError => {
    if (error instanceof AppError) {
        return error;
    }
    
    if (error instanceof Error) {
        // Check for specific error patterns and convert to appropriate AppError
        const message = error.message.toLowerCase();
        
        if (message.includes("timeout") || message.includes("aborted")) {
            return createTimeoutError(operation);
        }
        
        if (message.includes("not found") || message.includes("404")) {
            return new AppError(404, ErrorCodes.RESOURCE_NOT_FOUND, error.message);
        }
        
        if (message.includes("unauthorized") || message.includes("401")) {
            return createAuthError(error.message);
        }
        
        if (message.includes("forbidden") || message.includes("403")) {
            return createAuthorizationError(error.message);
        }
        
        // Default to internal error for unknown Error instances
        return new AppError(500, ErrorCodes.INTERNAL_ERROR, `${operation}: ${error.message}`, {
            originalError: error.name,
            stack: error.stack
        });
    }
    
    // Handle string errors
    if (typeof error === "string") {
        return new AppError(500, ErrorCodes.INTERNAL_ERROR, `${operation}: ${error}`);
    }
    
    // Handle unknown error types
    return new AppError(500, ErrorCodes.INTERNAL_ERROR, `${operation}: Unknown error occurred`, {
        originalError: error
    });
};

/**
 * Validates required fields and throws standardized error if any are missing
 */
export const validateRequired = (fields: Record<string, unknown>, fieldNames: string[]): void => {
    const missing = fieldNames.filter(name => {
        const value = fields[name];
        return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);
    });
    
    if (missing.length > 0) {
        throw new AppError(
            400, 
            ErrorCodes.MISSING_REQUIRED_FIELD, 
            `Missing required fields: ${missing.join(', ')}`
        );
    }
};

/**
 * Validates numeric inputs and throws standardized error if invalid
 */
export const validateNumeric = (value: unknown, fieldName: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw createValidationError(`${fieldName} must be a valid number`);
    }
    return value;
};

/**
 * Validates positive numeric inputs
 */
export const validatePositive = (value: unknown, fieldName: string): number => {
    const num = validateNumeric(value, fieldName);
    if (num <= 0) {
        throw createValidationError(`${fieldName} must be positive`);
    }
    return num;
};

/**
 * Validates non-negative numeric inputs
 */
export const validateNonNegative = (value: unknown, fieldName: string): number => {
    const num = validateNumeric(value, fieldName);
    if (num < 0) {
        throw createValidationError(`${fieldName} must be non-negative`);
    }
    return num;
};