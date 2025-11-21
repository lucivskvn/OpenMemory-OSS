import logger from "../../core/logger";

import { Context } from "../server";

export function request_logger_mw() {
    return async function (
        req: Request,
        ctx: Context,
        next: () => Promise<Response>,
    ) {
        // Generate a stable request id for tracing. Use crypto.randomUUID() when available.
        let reqId: string;
        try {
            // Bun and modern runtimes support crypto.randomUUID
            reqId =
                (globalThis as any).crypto?.randomUUID?.() ||
                `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        } catch (e) {
            reqId = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        }

        const url = new URL(req.url);
        const child =
            logger && typeof logger.child === "function"
                ? logger.child({
                      reqId,
                      method: req.method,
                      path: url.pathname,
                  })
                : logger;

        // Attach child logger to ctx and legacy req object for handlers expecting it
        try {
            (ctx as any).logger = child;
        } catch (e) {}
        try {
            (req as any).logger = child;
        } catch (e) {}

        // Also set a header so external clients can correlate logs with the response
        const resp = await next();
        try {
            resp.headers.set("X-Request-Id", reqId);
        } catch (e) {
            /* ignore if headers are immutable */
        }
        return resp;
    };
}
