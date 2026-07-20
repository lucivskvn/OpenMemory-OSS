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

function isIpv6PrivateOrRestricted(normalized: string): boolean {
    if (normalized === "::1" || normalized === "::") {
        return true;
    }

    const firstGroup = normalized.split(":")[0];
    const firstVal = Number.parseInt(firstGroup, 16);
    if (!Number.isNaN(firstVal)) {
        // fe80::/10 (Link-local): 0xfe80 to 0xfebf
        if (firstVal >= 0xfe80 && firstVal <= 0xfebf) return true;
        // fc00::/7 (Unique Local): 0xfc00 to 0xfdff
        if (firstVal >= 0xfc00 && firstVal <= 0xfdff) return true;
        // ff00::/8 (Multicast): 0xff00 to 0xffff
        if (firstVal >= 0xff00 && firstVal <= 0xffff) return true;
    }

    return false;
}

function isPrivateIpv4Octets(a: number, b: number): boolean {
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

    return false;
}

function isIpv4PrivateOrRestricted(normalized: string): boolean {
    const parts = normalized.split(".");
    if (parts.length === 4) {
        // Prevent octal parsing bypass (e.g. 0177.0.0.1 for 127.0.0.1)
        // Some libraries parse `0177` as `127` base 10 by stripping leading zeroes,
        // others parse it as octal. URL API parses 0177 -> 127 (base 8).
        const parsedParts = parts.map((p) => {
            if (p.length > 1 && p.startsWith("0")) {
                // Parse octal manually if it starts with 0 to match URL behavior
                return Number.parseInt(p, 8);
            }
            return Number(p);
        });

        if (parsedParts.every((p) => !Number.isNaN(p) && p >= 0 && p <= 255)) {
            return isPrivateIpv4Octets(parsedParts[0], parsedParts[1]);
        }
    }

    return false;
}

/**
 * SECURITY: SSRF (Server-Side Request Forgery) protection.
 * Checks whether an IP address belongs to loopback, private, link-local, or restricted ranges.
 */
export function isIpPrivateOrRestricted(ip: string): boolean {
    const normalized = ip.toLowerCase().trim();

    if (isIpv6PrivateOrRestricted(normalized)) {
        return true;
    }

    // IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (normalized.startsWith("::ffff:")) {
        const mapped = normalized.substring(7);
        // Handle hex notation like 7f00:1 (127.0.0.1)
        if (mapped.includes(":")) {
            const parts = mapped.split(":");
            if (parts.length === 2) {
                const p1 = Number.parseInt(parts[0], 16);
                const p2 = Number.parseInt(parts[1], 16);
                if (!Number.isNaN(p1) && !Number.isNaN(p2)) {
                    const a = (p1 >> 8) & 0xff;
                    const b = p1 & 0xff;
                    const c = (p2 >> 8) & 0xff;
                    const d = p2 & 0xff;
                    return isPrivateIpv4Octets(a, b);
                }
            }
        }
        return isIpPrivateOrRestricted(mapped);
    }

    return isIpv4PrivateOrRestricted(normalized);
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

async function resolveAndValidateHostname(hostname: string): Promise<string> {
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

    return pinnedIp;
}

async function executeRequestWithPin(
    parsedUrl: URL,
    pinnedIp: string,
    currentInit?: RequestInit,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const signal = currentInit?.signal;
    if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
    }

    const isHttps = parsedUrl.protocol === "https:";
    const requester = isHttps ? https : http;

    const requestHeaders = new Headers(currentInit?.headers);
    if (!requestHeaders.has("Host")) {
        requestHeaders.set("Host", parsedUrl.host);
    }

    const options: any = {
        hostname: pinnedIp,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: currentInit?.method || "GET",
        headers: Object.fromEntries(requestHeaders.entries()),
    };

    if (isHttps) {
        options.servername = parsedUrl.hostname; // SNI
    }

    return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
        let abortHandler: (() => void) | null = null;
        let req: any;

        const cleanupSignal = () => {
            if (signal && abortHandler) {
                signal.removeEventListener("abort", abortHandler);
            }
        };

        const handleData = (chunk: Buffer, chunks: Buffer[], state: { totalBytes: number }, maxResponseSize: number) => {
            state.totalBytes += chunk.length;
            if (state.totalBytes > maxResponseSize) {
                req.destroy(new Error("Response too large"));
                cleanupSignal();
                reject(new Error("Response too large"));
                return false; // stop processing
            }
            chunks.push(chunk);
            return true;
        };

        req = requester.request(options, (res) => {
            const chunks: Buffer[] = [];
            const state = { totalBytes: 0 };
            const maxResponseSize = 50 * 1024 * 1024; // 50MB safety limit

            res.on("data", (chunk) => {
                handleData(chunk, chunks, state, maxResponseSize);
            });

            res.on("end", () => {
                cleanupSignal();
                resolve({
                    status: res.statusCode || 200,
                    headers: res.headers as Record<string, string>,
                    body: Buffer.concat(chunks),
                });
            });
        });

        if (signal) {
            abortHandler = () => {
                req.destroy(new DOMException("The operation was aborted.", "AbortError"));
                reject(new DOMException("The operation was aborted.", "AbortError"));
            };
            signal.addEventListener("abort", abortHandler);
        }

        req.on("error", (err: Error) => {
            cleanupSignal();
            reject(err);
        });

        if (currentInit?.body) {
            req.write(currentInit.body);
        }
        req.end();
    });
}

function isRedirectStatus(status: number): boolean {
    return (
        status === 301 ||
        status === 302 ||
        status === 303 ||
        status === 307 ||
        status === 308
    );
}

function stripCrossOriginHeaders(
    currentInit: RequestInit | undefined,
    currentUrl: string,
    nextUrl: URL,
): RequestInit | undefined {
    if (!currentInit?.headers) return currentInit;

    const currentOrigin = new URL(currentUrl).origin;
    const targetOrigin = nextUrl.origin;

    if (currentOrigin !== targetOrigin) {
        const newHeaders = new Headers(currentInit.headers);
        newHeaders.delete("Authorization");
        newHeaders.delete("Cookie");
        newHeaders.delete("Proxy-Authorization");
        return {
            ...currentInit,
            headers: newHeaders,
        };
    }

    return currentInit;
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
        const pinnedIp = await resolveAndValidateHostname(hostname);

        // Perform the request pinning the validated IP address
        const { status, headers, body } = await executeRequestWithPin(parsedUrl, pinnedIp, currentInit);

        if (!isRedirectStatus(status)) {
            return new Response(body, {
                status,
                headers: new Headers(headers),
            });
        }

        if (redirectCount >= maxRedirects) {
            throw new Error("SSRF Prevention: Maximum redirect limit exceeded");
        }

        const location = headers["location"];
        if (!location) {
            return new Response(body, {
                status,
                headers: new Headers(headers),
            });
        }

        const nextUrl = new URL(location, currentUrl);

        // Strip credential-bearing headers if cross-origin
        currentInit = stripCrossOriginHeaders(currentInit, currentUrl, nextUrl);

        currentUrl = nextUrl.toString();
        redirectCount++;
    }
}
