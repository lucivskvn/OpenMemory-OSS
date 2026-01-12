import { lookup } from "dns/promises";
import { isIP } from "net";

export class NetworkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NetworkError";
    }
}

const PRIVATE_RANGES = [
    { start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8
    { start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8
    { start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12
    { start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16
    { start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16
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

export async function validateUrl(url_string: string): Promise<string> {
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
        // Forbidden IPv6 ranges:
        // - ::/128 (Unspecified)
        // - ::1/128 (Loopback)
        // - fe80::/10 (Link-local)
        // - fc00::/7 (Unique local)
        // - ::ffff:0:0/96 (IPv4-mapped)
        const normalized = ip.toLowerCase();
        const is_loopback =
            normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
        const is_unspecified =
            normalized === "::" || normalized === "0:0:0:0:0:0:0:0";
        const is_link_local = normalized.startsWith("fe80:");
        const is_unique_local =
            normalized.startsWith("fc") || normalized.startsWith("fd");
        const is_ipv4_mapped = normalized.startsWith("::ffff:");

        if (
            is_loopback ||
            is_unspecified ||
            is_link_local ||
            is_unique_local ||
            is_ipv4_mapped
        ) {
            if (is_ipv4_mapped) {
                const ipv4 = ip.split(":").pop();
                if (ipv4 && isIP(ipv4) === 4 && isPrivateIP(ipv4)) {
                    throw new NetworkError(
                        `Access to private IPv4-mapped IP ${ip} is forbidden`,
                    );
                }
            }
            throw new NetworkError(
                `Access to forbidden IPv6 address ${ip} is forbidden`,
            );
        }
    }

    return url_string;
}
