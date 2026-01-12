import { z } from "zod";

import { AppError, sendError } from "../errors";
import {
    AdvancedRequest,
    AdvancedResponse,
    Handler,
    NextFunction,
} from "../server";

/**
 * Middleware factory to validate request body against a Zod schema.
 */
export const validateBody = (schema: z.ZodSchema<any>): Handler => {
    return async (
        req: AdvancedRequest,
        res: AdvancedResponse,
        next: NextFunction,
    ) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            return sendError(
                res,
                new AppError(
                    400,
                    "VALIDATION_ERROR",
                    "Invalid request body",
                    result.error.format(),
                ),
            );
        }
        // Replace body with validated/transformed data
        req.body = result.data;
        await next();
    };
};

/**
 * Middleware factory to validate request query params against a Zod schema.
 */
export const validateQuery = (schema: z.ZodSchema<any>): Handler => {
    return async (
        req: AdvancedRequest,
        res: AdvancedResponse,
        next: NextFunction,
    ) => {
        // req.query is Record<string, string | string[] | undefined>
        // We might need to preprocess numbers/booleans if the schema expects them,
        // or rely on Zod's coerce.
        const result = schema.safeParse(req.query);
        if (!result.success) {
            return sendError(
                res,
                new AppError(
                    400,
                    "VALIDATION_ERROR",
                    "Invalid query parameters",
                    result.error.format(),
                ),
            );
        }
        // Replace query with validated/transformed data (cast to any to satisfy type overlap)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        req.query = result.data as any;
        await next();
    };
};

/**
 * Middleware factory to validate request path parameters against a Zod schema.
 */
export const validateParams = (schema: z.ZodSchema<any>): Handler => {
    return async (
        req: AdvancedRequest,
        res: AdvancedResponse,
        next: NextFunction,
    ) => {
        const result = schema.safeParse(req.params);
        if (!result.success) {
            return sendError(
                res,
                new AppError(
                    400,
                    "VALIDATION_ERROR",
                    "Invalid path parameters",
                    result.error.format(),
                ),
            );
        }
        // Replace params with validated/transformed data
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        req.params = result.data as any;
        await next();
    };
};
