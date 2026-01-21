/**
 * Application-specific error class for carrying HTTP status and error codes.
 */
export class AppError extends Error {
    public statusCode: number;
    public code: string;
    public details?: unknown;

    constructor(
        statusCode: number,
        code: string,
        message: string,
        details?: unknown,
    ) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        Object.setPrototypeOf(this, AppError.prototype);
    }
}

/**
 * Standardized JSON error response structure.
 * Compliant with RFC 7807 (Problem Details for HTTP APIs) where applicable.
 */
export interface ErrorResponse {
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
    // RFC 7807 fields
    type?: string;
    title?: string;
    status: number;
    instance?: string;
}

// sendError removed as it is replaced by Elysia's global error handler
