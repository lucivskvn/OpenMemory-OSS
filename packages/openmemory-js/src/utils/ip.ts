/**
 * @file ip.ts
 * @description Utility for extracting client IP address with proxy support.
 */

import { AdvancedRequest } from "../server/server";

/**
 * Extracts the real client IP address from a request.
 * If trustProxy is true, checks X-Forwarded-For and other proxy headers.
 * 
 * @param req - The request object
 * @param trustProxy - Whether to trust proxy headers
 * @returns The resolved IP address
 */
export function extractClientIp(req: AdvancedRequest, trustProxy: boolean): string {
    if (trustProxy) {
        // 1. Check Cloudflare
        const cfIp = req.headers["cf-connecting-ip"];
        if (typeof cfIp === "string") return cfIp;

        // 2. Check X-Forwarded-For (Standard)
        const forwarded = req.headers["x-forwarded-for"];
        if (typeof forwarded === "string") {
            // Can be a comma-separated list: "client, proxy1, proxy2"
            return forwarded.split(",")[0].trim();
        }

        // 3. Check X-Real-IP (Nginx/Alternative)
        const realIp = req.headers["x-real-ip"];
        if (typeof realIp === "string") return realIp;
    }

    // Default: Fallback to socket address populated by Bun
    return req.ip || "127.0.0.1";
}
