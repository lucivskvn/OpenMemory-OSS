import { AsyncLocalStorage } from "async_hooks";

import { normalizeUserId } from "../utils";

export interface SecurityContext {
    userId?: string;
    scopes?: string[];
    isAdmin?: boolean;
    requestId?: string;
}

export const contextStorage = new AsyncLocalStorage<SecurityContext>();

/**
 * Run a function within a security context.
 */
export const runInContext = <T>(ctx: SecurityContext, fn: () => T): T => {
    return contextStorage.run(ctx, fn);
};

/**
 * Get the current security context.
 */
export const getContext = (): SecurityContext | undefined => {
    return contextStorage.getStore();
};

/**
 * Require a user ID from the context or arguments.
 * If verified in context, strict match against arg is enforced.
 */
export const verifyContext = (
    argUserId?: string | null,
): string | null | undefined => {
    const ctx = getContext();
    const normalizedArg = normalizeUserId(argUserId);
    const rid = ctx?.requestId || "internal";

    // If no context exists (e.g., internal system task), we trust the argument
    if (!ctx) return normalizedArg;

    // If context has a user, it MUST match the argument if provided, or be the default if not
    if (ctx.userId) {
        if (normalizedArg && normalizedArg !== ctx.userId) {
            if (!ctx.isAdmin) {
                throw new Error(
                    `Unauthorized [req:${rid}]: Context user ${ctx.userId} cannot access data for user ${argUserId}`,
                );
            }
            // Admin can override and target a specific user
            return normalizedArg;
        }
        return ctx.userId;
    }

    // Context exists but has no userId (e.g., anonymous request or partially initialized)
    // We allow the arg but log it for auditing if it's a specific user request
    if (normalizedArg) {
        // This is a candidate for security alerts in a real system
        // console.warn(`[SECURITY] [req:${rid}] Anonymous context accessing data for user: ${normalizedArg}`);
    }

    return normalizedArg;
};
