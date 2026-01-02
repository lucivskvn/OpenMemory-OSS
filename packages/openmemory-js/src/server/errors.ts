
export class AppError extends Error {
    public statusCode: number;
    public code: string;
    public details?: any;

    constructor(statusCode: number, code: string, message: string, details?: any) {
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
        details?: any;
    };
}

export function sendError(res: any, err: unknown) {
    let appError: AppError;

    if (err instanceof AppError) {
        appError = err;
    } else if (err instanceof Error) {
        // Wrap generic errors
        const msg = err.message || "Internal Server Error";
        if (msg.includes("not found") || msg === "nf") {
            appError = new AppError(404, "NOT_FOUND", "Resource not found");
        } else if (msg.includes("unauthorized") || msg === "auth") {
            appError = new AppError(401, "UNAUTHORIZED", "Unauthorized access");
        } else {
            appError = new AppError(500, "INTERNAL_ERROR", msg);
        }
    } else {
        appError = new AppError(500, "UNKNOWN_ERROR", String(err));
    }

    // Log server errors
    if (appError.statusCode >= 500) {
        console.error(`[ERROR] ${appError.code}: ${appError.message}`, err);
    }

    const response: ErrorResponse = {
        error: {
            code: appError.code,
            message: appError.message,
            details: appError.details,
        },
    };

    // If 'res' is an AdvancedResponse-like object (Express/Bun)
    if (res && typeof res.status === "function" && typeof res.json === "function") {
        res.status(appError.statusCode).json(response);
    } else {
        console.error("[sendError] Invalid response object:", err);
    }
}
