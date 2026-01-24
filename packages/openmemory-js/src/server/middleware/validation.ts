/**
 * @file Validation Middleware for API Endpoints
 * Provides comprehensive input validation using Zod schemas and security sanitization
 */

import { Elysia } from "elysia";
import { z } from "zod";
import { AppError } from "../errors";
import { logger } from "../../utils/logger";
import { SecurityError } from "../../core/security";
import { createInputValidator } from "../../utils/inputSanitization";

/**
 * Validation error handler
 */
function handleValidationError(error: unknown, context: string): never {
    if (error instanceof z.ZodError) {
        const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        logger.warn(`[Validation] ${context} validation failed`, { errors: error.errors });
        throw new AppError(400, "VALIDATION_ERROR", `Input validation failed: ${messages}`);
    }
    
    if (error instanceof SecurityError) {
        logger.warn(`[Validation] ${context} security validation failed`, { error: error.message });
        throw new AppError(400, "SECURITY_VALIDATION_ERROR", error.message);
    }
    
    logger.error(`[Validation] Unexpected ${context} validation error`, { error });
    throw new AppError(500, "INTERNAL_ERROR", "Validation error occurred");
}

/**
 * Body validation middleware factory
 */
export function validateBody<T>(schema: z.ZodSchema<T>) {
    const validator = createInputValidator(schema);
    
    return (app: Elysia) => app.onTransform(({ body, set }) => {
        try {
            if (body !== undefined) {
                return { body: validator(body) };
            }
        } catch (error) {
            handleValidationError(error, "Body");
        }
    });
}

/**
 * Query parameters validation middleware factory
 */
export function validateQuery<T>(schema: z.ZodSchema<T>) {
    const validator = createInputValidator(schema);
    
    return (app: Elysia) => app.onTransform(({ query, set }) => {
        try {
            if (query !== undefined) {
                return { query: validator(query) };
            }
        } catch (error) {
            handleValidationError(error, "Query");
        }
    });
}

/**
 * Path parameters validation middleware factory
 */
export function validateParams<T>(schema: z.ZodSchema<T>) {
    const validator = createInputValidator(schema);
    
    return (app: Elysia) => app.onTransform(({ params, set }) => {
        try {
            if (params !== undefined) {
                return { params: validator(params) };
            }
        } catch (error) {
            handleValidationError(error, "Parameters");
        }
    });
}

/**
 * Headers validation middleware factory
 */
export function validateHeaders<T>(schema: z.ZodSchema<T>) {
    const validator = createInputValidator(schema);
    
    return (app: Elysia) => app.onTransform(({ headers, set }) => {
        try {
            if (headers !== undefined) {
                // Convert Headers object to plain object for validation
                const headersObj: Record<string, string> = {};
                if (headers && typeof headers.forEach === 'function') {
                    headers.forEach((value: string, key: string) => {
                        headersObj[key.toLowerCase()] = value;
                    });
                } else if (headers && typeof headers === 'object') {
                    Object.assign(headersObj, headers);
                }
                
                return { headers: validator(headersObj) };
            }
        } catch (error) {
            handleValidationError(error, "Headers");
        }
    });
}

/**
 * Comprehensive validation middleware that validates all request parts
 */
export function validateRequest<
    TBody = unknown,
    TQuery = unknown,
    TParams = unknown,
    THeaders = unknown
>(schemas: {
    body?: z.ZodSchema<TBody>;
    query?: z.ZodSchema<TQuery>;
    params?: z.ZodSchema<TParams>;
    headers?: z.ZodSchema<THeaders>;
}) {
    return (app: Elysia) => {
        let result = app;
        
        if (schemas.body) {
            result = result.use(validateBody(schemas.body));
        }
        
        if (schemas.query) {
            result = result.use(validateQuery(schemas.query));
        }
        
        if (schemas.params) {
            result = result.use(validateParams(schemas.params));
        }
        
        if (schemas.headers) {
            result = result.use(validateHeaders(schemas.headers));
        }
        
        return result;
    };
}

/**
 * Common validation schemas for reuse
 */
export const CommonSchemas = {
    // Pagination
    pagination: z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        offset: z.coerce.number().int().min(0).default(0),
    }),
    
    // Sorting
    sorting: z.object({
        sortBy: z.string().max(50).optional(),
        sortOrder: z.enum(['asc', 'desc']).default('desc'),
    }),
    
    // Time range
    timeRange: z.object({
        startTime: z.coerce.number().int().optional(),
        endTime: z.coerce.number().int().optional(),
    }).refine(data => {
        if (data.startTime && data.endTime) {
            return data.startTime <= data.endTime;
        }
        return true;
    }, {
        message: "Start time must be before end time"
    }),
    
    // Search
    search: z.object({
        q: z.string().min(1).max(1000).optional(),
        query: z.string().min(1).max(1000).optional(),
    }),
    
    // Common headers
    apiHeaders: z.object({
        'x-api-key': z.string().optional(),
        'authorization': z.string().optional(),
        'content-type': z.string().optional(),
        'user-agent': z.string().max(500).optional(),
    }),
};

/**
 * Validation middleware plugin for Elysia applications
 */
export const validationPlugin = (app: Elysia) => app
    .onError(({ error, set }) => {
        if (error instanceof z.ZodError) {
            const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
            logger.warn("[Validation] Zod validation failed", { errors: error.errors });
            set.status = 400;
            return {
                error: "Validation failed",
                message: messages,
                code: "VALIDATION_ERROR",
                details: error.errors
            };
        }
        
        if (error instanceof SecurityError) {
            logger.warn("[Validation] Security validation failed", { error: error.message });
            set.status = 400;
            return {
                error: "Security validation failed",
                message: error.message,
                code: "SECURITY_ERROR"
            };
        }
    });

/**
 * Enhanced validation plugin with additional security features
 */
export const enhancedValidationPlugin = (app: Elysia) => app
    .use(validationPlugin)
    .derive(({ request }) => {
        // Add validation context
        const validationContext = {
            timestamp: Date.now(),
            userAgent: request.headers.get('user-agent') || 'unknown',
            contentType: request.headers.get('content-type') || 'unknown',
            contentLength: request.headers.get('content-length') || '0',
        };
        
        return { validationContext };
    });