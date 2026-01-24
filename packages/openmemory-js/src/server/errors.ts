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

/**
 * Standardized function to generate a JSON error response.
 * Useful for manual error handling or testing.
 */
export const sendError = (
    res: { status: (s: number) => any, json: (j: any) => any },
    error: any,
): void => {
    const isApp = error instanceof AppError;
    const isError = error instanceof Error;

    const status = isApp ? (error as AppError).statusCode : 500;
    const code = isApp ? (error as AppError).code : "INTERNAL_ERROR";
    const message = isError ? error.message : (typeof error === "string" ? error : "Internal Server Error");
    const details = isApp ? (error as AppError).details : (isError ? {} : undefined);

    const body: ErrorResponse = {
        error: {
            code,
            message,
            details,
        },
        status,
        title: code,
        type: "about:blank",
    };
    res.status(status).json(body);
};
