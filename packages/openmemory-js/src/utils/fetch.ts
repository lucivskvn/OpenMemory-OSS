import { propagation, context } from "@opentelemetry/api";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";

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

    // IPv6 Loopback or unspecified
    if (normalized === "::1" || normalized === "::") {
        return true;
    }

    // Advanced IPv6 range validation
    const firstGroup = normalized.split(":")[0];
    const firstVal = parseInt(firstGroup, 16);
    if (!isNaN(firstVal)) {
        // fe80::/10 (Link-local): 0xfe80 to 0xfebf
        if (firstVal >= 0xfe80 && firstVal <= 0xfebf) return true;
        // fc00::/7 (Unique Local): 0xfc00 to 0xfdff
        if (firstVal >= 0xfc00 && firstVal <= 0xfdff) return true;
        // ff00::/8 (Multicast): 0xff00 to 0xffff
        if (firstVal >= 0xff00 && firstVal <= 0xffff) return true;
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
        // 100.64.0.0/10 (carrier-grade NAT)
        if (a === 100 && b >= 64 && b <= 127) return true;
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

/**
 * SECURITY: SSRF-safe fetch wrapper that resolves and validates redirects manual-style.
 * This prevents attackers from bypassing SSRF checks via HTTP redirects (e.g., redirecting
 * from a public domain to localhost).
 * It also pins the resolved IP address to prevent TOCTOU (DNS Rebinding) attacks.
 */
export async function fetchWithSsrfProtection(
    urlStr: string,
    init?: RequestInit,
    maxRedirects: number = 5,
): Promise<Response> {
    let currentUrl = urlStr;
    let redirectCount = 0;
    let currentInit = init ? { ...init } : undefined;

    while (true) {
        const parsedUrl = new URL(currentUrl);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            throw new Error(`SSRF Prevention: Unsupported protocol: ${parsedUrl.protocol}`);
        }

        const hostname = parsedUrl.hostname;

        // Resolve DNS once to pin the IP address (prevents DNS Rebinding / TOCTOU)
        const addresses = await dns.lookup(hostname, { all: true });
        let pinnedIp = "";
        for (const addr of addresses) {
            if (isIpPrivateOrRestricted(addr.address)) {
                throw new Error(`SSRF Prevention: Unsafe IP address: ${addr.address} resolved from ${hostname}`);
            }
            if (!pinnedIp) {
                pinnedIp = addr.address;
            }
        }

        if (!pinnedIp) {
            throw new Error(`SSRF Prevention: Could not resolve IP address for hostname: ${hostname}`);
        }

        // Perform the request pinning the validated IP address
        const isHttps = parsedUrl.protocol === "https:";
        const requester = isHttps ? https : http;

        const requestHeaders = new Headers(currentInit?.headers);
        if (!requestHeaders.has("Host")) {
            requestHeaders.set("Host", hostname);
        }

        const options: any = {
            hostname: pinnedIp,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: currentInit?.method || "GET",
            headers: Object.fromEntries(requestHeaders.entries()),
        };

        if (isHttps) {
            options.servername = hostname; // SNI
        }

        const responsePromise = new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
            const req = requester.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode || 200,
                        headers: res.headers as Record<string, string>,
                        body: Buffer.concat(chunks),
                    });
                });
            });

            req.on("error", (err) => reject(err));

            // Write body if present
            if (currentInit?.body) {
                req.write(currentInit.body);
            }
            req.end();
        });

        const { status, headers, body } = await responsePromise;

        const isRedirect =
            status === 301 ||
            status === 302 ||
            status === 303 ||
            status === 307 ||
            status === 308;

        if (!isRedirect) {
            const headersObj = new Headers(headers);
            return new Response(body, {
                status,
                headers: headersObj,
            });
        }

        if (redirectCount >= maxRedirects) {
            throw new Error("SSRF Prevention: Maximum redirect limit exceeded");
        }

        const location = headers["location"];
        if (!location) {
            const headersObj = new Headers(headers);
            return new Response(body, {
                status,
                headers: headersObj,
            });
        }

        const nextUrl = new URL(location, currentUrl);

        // Strip credential-bearing headers if cross-origin
        if (currentInit && currentInit.headers) {
            const currentOrigin = new URL(currentUrl).origin;
            const targetOrigin = nextUrl.origin;

            if (currentOrigin !== targetOrigin) {
                const newHeaders = new Headers(currentInit.headers);
                newHeaders.delete("Authorization");
                newHeaders.delete("Cookie");
                newHeaders.delete("Proxy-Authorization");
                currentInit = {
                    ...currentInit,
                    headers: newHeaders,
                };
            }
        }

        currentUrl = nextUrl.toString();
        redirectCount++;
    }
}
