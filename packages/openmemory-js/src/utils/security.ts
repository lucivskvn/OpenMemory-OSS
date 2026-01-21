/**
 * @file Network Security Utilities.
 * Provides Server-Side Request Forgery (SSRF) protection by resolving and validating IPs
 * before allowing outbound requests.
 */

import { lookup } from "dns/promises";
import { isIP } from "net";

export class NetworkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NetworkError";
    }
}

const PRIVATE_RANGES = [
    { start: 0x00000000, end: 0x00ffffff }, // 0.0.0.0/8 (Current network)
    { start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8 (Private-Use)
    { start: 0x64400000, end: 0x647fffff }, // 100.64.0.0/10 (Shared Address Space)
    { start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8 (Loopback)
    { start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16 (Link-Local)
    { start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12 (Private-Use)
    { start: 0xc0000000, end: 0xc0000007 }, // 192.0.0.0/29 (DS-Lite)
    { start: 0xc0000200, end: 0xc00002ff }, // 192.0.2.0/24 (TEST-NET-1)
    { start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16 (Private-Use)
    { start: 0xc6120000, end: 0xc613ffff }, // 198.18.0.0/15 (Benchmarking)
    { start: 0xc6336400, end: 0xc63364ff }, // 198.51.100.0/24 (TEST-NET-2)
    { start: 0xcb007100, end: 0xcb0071ff }, // 203.0.113.0/24 (TEST-NET-3)
    { start: 0xe0000000, end: 0xffffffff }, // 224.0.0.0/4 (Multicast/Reserved)
];

function ipToInt(ip: string): number {
    return (
        ip
            .split(".")
            .reduce((sum, part) => (sum << 8) + parseInt(part, 10), 0) >>> 0
    );
}

function isPrivateIP(ip: string): boolean {
    const num = ipToInt(ip);
    return PRIVATE_RANGES.some(({ start, end }) => num >= start && num <= end);
}

/**
 * Validates a URL and resolves its hostname to an IP to prevent SSRF attacks.
 * Blocks access to private/internal IP ranges and loopback addresses.
 *
 * @param url_string - The URL to validate.
 * @returns Object containing the safe URL (with resolved IP), the IP, and original URL.
 * @throws {NetworkError} If protocol is invalid, DNS fails, or IP is blocked.
 */
export async function validateUrl(url_string: string): Promise<{ url: string; ip: string; originalUrl: string }> {
    const url = new URL(url_string);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new NetworkError(`Invalid protocol: ${url.protocol}`);
    }

    const hostname = url.hostname;
    let ip = hostname;

    // If hostname is not an IP, resolve it
    if (isIP(hostname) === 0) {
        try {
            const { address } = await lookup(hostname);
            ip = address;
        } catch {
            throw new NetworkError(`DNS resolution failed for ${hostname}`);
        }
    }

    // IPv4 checks
    if (isIP(ip) === 4) {
        if (isPrivateIP(ip)) {
            throw new NetworkError(`Access to private IP ${ip} is forbidden`);
        }
    }

    // IPv6 checks
    if (isIP(ip) === 6) {
        const normalized = ip.toLowerCase();
        const is_loopback = normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
        const is_unspecified = normalized === "::" || normalized === "0:0:0:0:0:0:0:0";
        const is_link_local = normalized.startsWith("fe80:");
        const is_unique_local = normalized.startsWith("fc") || normalized.startsWith("fd");
        const is_ipv4_mapped = normalized.startsWith("::ffff:");

        if (is_loopback || is_unspecified || is_link_local || is_unique_local || is_ipv4_mapped) {
            if (is_ipv4_mapped) {
                const ipv4 = ip.split(":").pop();
                if (ipv4 && isIP(ipv4) === 4 && isPrivateIP(ipv4)) {
                    throw new NetworkError(`Access to private IPv4-mapped IP ${ip} is forbidden`);
                }
            }
            throw new NetworkError(`Access to forbidden IPv6 address ${ip} is forbidden`);
        }
    }

    // Construct a safe URL using the resolved IP to prevent DNS rebinding
    const safeUrl = new URL(url_string);
    safeUrl.hostname = ip;

    return {
        url: safeUrl.toString(), // URL with IP as hostname
        ip,
        originalUrl: url_string
    };
}
