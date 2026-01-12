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

import { env } from "../core/cfg";
import { logger } from "../utils/logger";

/**
 * Standardized error sender for API responses.
 * Masks internal details in production to prevent data leakage.
 */
export const sendError = (
    res: {
        status: (code: number) => { json: (body: unknown) => void };
        json: (body: unknown) => void;
    },
    error: unknown,
) => {
    // logger.debug("[DEBUG] sendError called with:", error);
    let appError: AppError;

    const isProd = env.isProd;

    if (error instanceof AppError) {
        appError = error;
    } else if (error instanceof Error) {
        // Wrap generic errors
        const msg = error.message || "Internal Server Error";
        if (msg.includes("not found") || msg === "nf") {
            appError = new AppError(404, "NOT_FOUND", msg);
        } else if (msg.includes("unauthorized") || msg === "auth") {
            appError = new AppError(401, "UNAUTHORIZED", msg);
        } else if (msg.includes("forbidden") || msg === "noperm") {
            appError = new AppError(403, "FORBIDDEN", msg);
        } else {
            appError = new AppError(500, "INTERNAL_ERROR", msg);
        }
        // In dev, attach stack
        if (!isProd) {
            appError.details = { stack: error.stack };
        }
    } else {
        // Unknown type
        appError = new AppError(500, "INTERNAL_ERROR", String(error));
    }

    const body: ErrorResponse = {
        error: {
            code: appError.code,
            message: appError.message,
        },
        status: appError.statusCode,
        title: appError.code,
        type: "about:blank",
    };

    if (appError.details) {
        body.error.details = appError.details;
    }

    // Only log actual 500s or unexpected errors
    if (appError.statusCode >= 500) {
        logger.error(
            `[API] Error ${appError.code}: ${appError.message}`,
            { error },
        );
    }

    // If 'res' is an AdvancedResponse-like object (Express/Bun)
    if (
        res &&
        typeof res.status === "function" &&
        typeof res.json === "function"
    ) {
        res.status(appError.statusCode).json(body);
    } else {
        logger.error("[sendError] Invalid response object:", { error });
    }
};
