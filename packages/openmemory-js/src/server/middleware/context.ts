import { Elysia } from "elysia";
import { contextStorage, SecurityContext } from "../../core/context";
import { getUser } from "./auth";
import { rid } from "../../utils";

/**
 * Middleware to wrap the request execution in an AsyncLocalStorage context.
 * This ensures that core layers can access security info via getContext().
 */
export const contextPlugin = (app: Elysia) => app.onBeforeHandle(async (ctx) => {
    const user = getUser(ctx);
    if (!user) return; // Public endpoint or not yet authenticated

    const securityCtx: SecurityContext = {
        userId: user.id || undefined,
        scopes: user.scopes || [],
        isAdmin: (user.scopes || []).includes("admin:all"),
        requestId: (ctx as any).store?.requestId || rid(),
        ip: app.server?.requestIP(ctx.request)?.address,
        userAgent: ctx.request.headers.get("user-agent") || undefined,
    };

    // Use enterWith to set context for the remainder of this promise chain (the handler)
    contextStorage.enterWith(securityCtx);
});
