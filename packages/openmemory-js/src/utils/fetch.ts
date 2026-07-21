import { propagation, context } from "@opentelemetry/api";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";

/**
 * Enhanced fetch with OpenTelemetry trace context propagation and default timeout.
 */
export async function fetchWithTrace(
    url: string | URL | Request,
    init?: RequestInit
): Promise<Response> {
    const headers = new Headers(init?.headers);

    // Inject current trace context into headers using the active context
    propagation.inject(context.active(), headers, {
        set: (h, k, v) => h.set(k, v)
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
            signal
        });
        return response;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

/**
 * SSRF Protection Utilities and Helper Functions
 */

export function isIpv4PrivateOrRestricted(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (
        parts.length !== 4 ||
        parts.some(Number.isNaN) ||
        parts.some((p) => p < 0 || p > 255)
    ) {
        return true; // Treat invalid as restricted
    }
    const [a, b] = parts;

    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (private)
    if (a === 10) return true;
    // 0.0.0.0/8 (broadcast/any)
    if (a === 0) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 192.168.0.0/16 (private)
    if (a === 192 && b === 168) return true;
    // 172.16.0.0/12 (private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;

    return false;
}

function expandIpv4Mapped(normalized: string): string | null {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4Part = normalized.slice(lastColon + 1);
    const parts = ipv4Part.split(".").map(Number);
    if (
        parts.length !== 4 ||
        parts.some(Number.isNaN) ||
        parts.some((p) => p < 0 || p > 255)
    ) {
        return null;
    }
    const [a, b] = parts;
    const hex1 = ((a << 8) | b).toString(16);
    const hex2 = ((parts[2] << 8) | parts[3]).toString(16);
    return normalized.slice(0, lastColon + 1) + hex1 + ":" + hex2;
}

function parseHexParts(partStr: string): number[] | null {
    const parts = partStr.split(":");
    const result: number[] = [];
    for (const part of parts) {
        const val = Number.parseInt(part, 16);
        if (Number.isNaN(val) || val < 0 || val > 0xffff) return null;
        result.push(val);
    }
    return result;
}

export function parseIpv6(ip: string): number[] | null {
    let normalized = ip.trim().toLowerCase();

    // Strip square brackets if present
    if (normalized.startsWith("[") && normalized.endsWith("]")) {
        normalized = normalized.slice(1, -1);
    }

    // Handle IPv4-mapped IPv6, e.g. ::ffff:192.168.0.1
    if (normalized.includes(".")) {
        const expanded = expandIpv4Mapped(normalized);
        if (expanded === null) return null;
        normalized = expanded;
    }

    // Split on double colon to handle shorthand expansion
    const partsByDoubleColon = normalized.split("::");
    if (partsByDoubleColon.length > 2) return null; // More than one '::' is invalid

    const left: number[] = [];
    const right: number[] = [];

    if (partsByDoubleColon[0] !== "") {
        const parsedLeft = parseHexParts(partsByDoubleColon[0]);
        if (parsedLeft === null) return null;
        left.push(...parsedLeft);
    }

    if (partsByDoubleColon.length === 2 && partsByDoubleColon[1] !== "") {
        const parsedRight = parseHexParts(partsByDoubleColon[1]);
        if (parsedRight === null) return null;
        right.push(...parsedRight);
    }

    const missingCount = 8 - (left.length + right.length);
    if (missingCount < 0) return null;

    const middle = new Array(missingCount).fill(0);
    return [...left, ...middle, ...right];
}

export function isIpv6PrivateOrRestricted(ip: string): boolean {
    const words = parseIpv6(ip);
    if (!words) return true; // Invalid is treated as restricted

    // Unspecified ::/128
    if (words.every((w) => w === 0)) return true;

    // Loopback ::1/128
    if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;

    // fe80::/10 (link-local)
    if ((words[0] & 0xffc0) === 0xfe80) return true;

    // fc00::/7 (unique local)
    if ((words[0] & 0xfe00) === 0xfc00) return true;

    // ff00::/8 (multicast)
    if ((words[0] & 0xff00) === 0xff00) return true;

    // IPv4-mapped IPv6: ::ffff:0:0/96
    if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
        const ipv4Str = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
        if (isIpv4PrivateOrRestricted(ipv4Str)) return true;
    }

    return false;
}

function resolveDns(
    hostname: string,
): Promise<{ address: string; family: number }> {
    // Strip square brackets if present (e.g. standard IPv6 URL literal notation)
    const cleanHostname =
        hostname.startsWith("[") && hostname.endsWith("]")
            ? hostname.slice(1, -1)
            : hostname;

    return new Promise((resolve, reject) => {
        dns.lookup(cleanHostname, { all: false }, (err, address, family) => {
            if (err) {
                reject(err);
            } else {
                resolve({ address, family });
            }
        });
    });
}

export interface FetchSsrfOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    signal?: AbortSignal;
    maxRedirects?: number;
    timeout?: number;
}

export interface FetchSsrfResponse {
    status: number;
    statusText: string;
    headers: Headers;
    ok: boolean;
    text: () => Promise<string>;
    buffer: () => Promise<Buffer>;
    json: () => Promise<any>;
    arrayBuffer: () => Promise<ArrayBuffer>;
}

function createFetchResponse(
    statusCode: number,
    statusMessage: string,
    responseHeaders: Headers,
    buffer: Buffer
): FetchSsrfResponse {
    return {
        status: statusCode,
        statusText: statusMessage,
        headers: responseHeaders,
        ok: statusCode >= 200 && statusCode < 300,
        text: async () => buffer.toString("utf8"),
        buffer: async () => buffer,
        json: async () => JSON.parse(buffer.toString("utf8")),
        arrayBuffer: async () => buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength
        ),
    };
}

export async function fetchWithSsrfProtection(
    url: string,
    options: FetchSsrfOptions = {},
    redirectCount = 0,
): Promise<FetchSsrfResponse> {
    let urlObj: URL;
    try {
        urlObj = new URL(url);
    } catch (e: any) {
        throw new Error(`Invalid URL: ${url}`);
    }

    // Only support http and https protocols
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${urlObj.protocol}`);
    }

    // Resolve hostname once
    const { address, family } = await resolveDns(urlObj.hostname);

    // Check IP
    if (family === 4) {
        if (isIpv4PrivateOrRestricted(address)) {
            throw new Error(
                `Access to private/restricted IP range blocked: ${address}`,
            );
        }
    } else if (family === 6) {
        if (isIpv6PrivateOrRestricted(address)) {
            throw new Error(
                `Access to private/restricted IP range blocked: ${address}`,
            );
        }
    } else {
        throw new Error(`Unsupported IP family: ${family}`);
    }

    return new Promise<FetchSsrfResponse>((resolve, reject) => {
        const isHttps = urlObj.protocol === "https:";
        const requester = isHttps ? https : http;

        const defaultPort = isHttps ? "443" : "80";
        let hostHeader = urlObj.hostname;
        if (urlObj.port && urlObj.port !== defaultPort) {
            hostHeader = `${urlObj.hostname}:${urlObj.port}`;
        }

        const headers = { ...options.headers };
        headers["host"] = hostHeader;

        let port = isHttps ? 443 : 80;
        if (urlObj.port) {
            port = Number.parseInt(urlObj.port, 10);
        }

        const reqOptions: any = {
            method: options.method || "GET",
            hostname: address,
            port,
            path: urlObj.pathname + urlObj.search,
            headers,
        };

        if (isHttps) {
            reqOptions.servername = urlObj.hostname; // SNI
        }

        if (options.signal) {
            if (options.signal.aborted) {
                reject(new Error("The operation was aborted."));
                return;
            }
        }

        // Apply timeout if provided
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        if (options.timeout) {
            timeoutId = setTimeout(() => {
                req.destroy();
                cleanup();
                reject(new Error("Request timed out"));
            }, options.timeout);
        }

        const req = requester.request(reqOptions, (res) => {
            const statusCode = res.statusCode || 200;
            const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);

            if (isRedirect) {
                cleanup();
                res.resume(); // Drain current response stream before following recursively
                const location = res.headers.location;
                if (!location) {
                    reject(
                        new Error(
                            `Redirect status ${statusCode} with no location header`,
                        ),
                    );
                    return;
                }

                const maxRedirects = options.maxRedirects ?? 5;
                if (redirectCount >= maxRedirects) {
                    reject(new Error(`Too many redirects (max ${maxRedirects})`));
                    return;
                }

                const redirectUrlObj = new URL(location, urlObj.toString());
                const isCrossOrigin =
                    redirectUrlObj.protocol !== urlObj.protocol ||
                    redirectUrlObj.hostname !== urlObj.hostname ||
                    redirectUrlObj.port !== urlObj.port;

                const nextHeaders = { ...headers };
                if (isCrossOrigin) {
                    // Stripping credentials case-insensitively
                    for (const key of Object.keys(nextHeaders)) {
                        const lowerKey = key.toLowerCase();
                        if (["authorization", "cookie", "x-api-key", "cookie2"].includes(lowerKey)) {
                            delete nextHeaders[key];
                        }
                    }
                }

                resolve(
                    fetchWithSsrfProtection(
                        redirectUrlObj.toString(),
                        {
                            ...options,
                            headers: nextHeaders,
                        },
                        redirectCount + 1,
                    ),
                );
                return;
            }

            const chunks: Buffer[] = [];
            let totalBytes = 0;
            const maxBytes = 50 * 1024 * 1024; // 50MB

            res.on("data", (chunk: Buffer) => {
                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    res.destroy();
                    req.destroy();
                    cleanup();
                    reject(new Error("Response size exceeded 50MB limit"));
                    return;
                }
                chunks.push(chunk);
            });

            res.on("end", () => {
                cleanup();
                const buffer = Buffer.concat(chunks);

                const responseHeaders = new Headers();
                for (const [key, val] of Object.entries(res.headers)) {
                    if (val) {
                        if (Array.isArray(val)) {
                            for (const v of val) {
                                responseHeaders.append(key, v);
                            }
                        } else {
                            responseHeaders.set(key, val);
                        }
                    }
                }

                resolve(createFetchResponse(statusCode, res.statusMessage || "", responseHeaders, buffer));
            });

            res.on("error", (err) => {
                cleanup();
                reject(err);
            });
        });

        let abortHandler: (() => void) | null = null;
        if (options.signal) {
            abortHandler = () => {
                req.destroy();
                cleanup();
                reject(new Error("The operation was aborted."));
            };
            options.signal.addEventListener("abort", abortHandler);
        }

        const cleanup = () => {
            if (options.signal && abortHandler) {
                options.signal.removeEventListener("abort", abortHandler);
            }
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        };

        req.on("error", (err) => {
            cleanup();
            reject(err);
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}
