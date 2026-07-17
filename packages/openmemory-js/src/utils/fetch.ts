import { propagation, context } from "@opentelemetry/api";
import dns from "node:dns/promises";

/**
 * Enhanced fetch with OpenTelemetry trace context propagation and default timeout.
 */
export async function fetchWithTrace(
    url: string | URL | Request,
    init?: RequestInit,
): Promise<Response> {
    const headers = new Headers(init?.headers);

    // Inject current trace context into headers using the active context
    propagation.inject(context.active(), headers, {
        set: (h, k, v) => h.set(k, v),
    });

    // Apply a default timeout of 30 seconds if no signal is provided
    let signal = init?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (!signal) {
        const controller = new AbortController();
        signal = controller.signal;
        timeoutId = setTimeout(() => controller.abort(), 30000);
    }

    try {
        const response = await fetch(url, {
            ...init,
            headers,
            signal,
        });
        return response;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

/**
 * SECURITY: SSRF (Server-Side Request Forgery) protection.
 * Checks whether an IP address belongs to loopback, private, link-local, or restricted ranges.
 */
export function isIpPrivateOrRestricted(ip: string): boolean {
    const normalized = ip.toLowerCase().trim();

    // IPv6 Loopback, unspecified, link-local, unique local, or multicast
    if (
        normalized === "::1" ||
        normalized === "::" ||
        normalized.startsWith("fe80:") ||
        normalized.startsWith("fc00:") ||
        normalized.startsWith("fd00:") ||
        normalized.startsWith("ff00:")
    ) {
        return true;
    }

    // IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1)
    if (normalized.startsWith("::ffff:")) {
        return isIpPrivateOrRestricted(normalized.substring(7));
    }

    // IPv4 address parsing and range validation
    const parts = normalized.split(".").map(Number);
    if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
        const [a, b, c, d] = parts;
        // 127.0.0.0/8 (loopback)
        if (a === 127) return true;
        // 10.0.0.0/8 (private)
        if (a === 10) return true;
        // 172.16.0.0/12 (private)
        if (a === 172 && b >= 16 && b <= 31) return true;
        // 192.168.0.0/16 (private)
        if (a === 192 && b === 168) return true;
        // 169.254.0.0/16 (link-local, cloud metadata)
        if (a === 169 && b === 254) return true;
        // 0.0.0.0/8 (unspecified)
        if (a === 0) return true;
        // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved)
        if (a >= 224) return true;
    }

    return false;
}

/**
 * SECURITY: SSRF prevention.
 * Validates that the protocol is strictly http or https and that the URL
 * does not resolve to any loopback, private, or restricted IP address.
 */
export async function isSafeUrl(urlStr: string): Promise<boolean> {
    try {
        const parsed = new URL(urlStr);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return false;
        }

        const hostname = parsed.hostname;

        // Check if the hostname itself is a private IP address
        if (isIpPrivateOrRestricted(hostname)) {
            return false;
        }

        // Resolve DNS and check all returned IP addresses (IPv4 and IPv6) to prevent DNS rebinding
        const addresses = await dns.lookup(hostname, { all: true });
        for (const addr of addresses) {
            if (isIpPrivateOrRestricted(addr.address)) {
                return false;
            }
        }

        return true;
    } catch {
        // If parsing or DNS resolution fails, fail closed for security.
        return false;
    }
}
