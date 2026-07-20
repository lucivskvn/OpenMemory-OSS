import { describe, expect, it } from "bun:test";
import {
    isIpv4PrivateOrRestricted,
    isIpv6PrivateOrRestricted,
    parseIpv6,
    fetchWithSsrfProtection,
} from "../src/utils/fetch";

describe("SSRF IP Validation - IPv4", () => {
    it("identifies private and restricted IPv4 addresses", () => {
        expect(isIpv4PrivateOrRestricted("127.0.0.1")).toBe(true);
        expect(isIpv4PrivateOrRestricted("10.0.0.5")).toBe(true);
        expect(isIpv4PrivateOrRestricted("172.16.31.254")).toBe(true);
        expect(isIpv4PrivateOrRestricted("192.168.1.100")).toBe(true);
        expect(isIpv4PrivateOrRestricted("169.254.1.1")).toBe(true);
        expect(isIpv4PrivateOrRestricted("100.64.0.50")).toBe(true);
        expect(isIpv4PrivateOrRestricted("0.0.0.0")).toBe(true);
    });

    it("identifies safe public IPv4 addresses", () => {
        expect(isIpv4PrivateOrRestricted("8.8.8.8")).toBe(false);
        expect(isIpv4PrivateOrRestricted("1.1.1.1")).toBe(false);
        expect(isIpv4PrivateOrRestricted("142.250.190.46")).toBe(false);
    });

    it("handles invalid or malformed IPv4s by treating them as restricted", () => {
        expect(isIpv4PrivateOrRestricted("999.999.999.999")).toBe(true);
        expect(isIpv4PrivateOrRestricted("abc.def.ghi.jkl")).toBe(true);
        expect(isIpv4PrivateOrRestricted("12.34")).toBe(true);
    });
});

describe("SSRF IP Validation - IPv6", () => {
    it("parses diverse IPv6 formats correctly", () => {
        expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
        expect(parseIpv6("2001:db8::ff00:42:8329")).toEqual([
            0x2001, 0x0db8, 0, 0, 0, 0xff00, 0x0042, 0x8329,
        ]);
        expect(parseIpv6("::ffff:192.168.1.1")).toEqual([
            0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0101,
        ]);
    });

    it("identifies private and restricted IPv6 addresses", () => {
        expect(isIpv6PrivateOrRestricted("::1")).toBe(true); // Loopback
        expect(isIpv6PrivateOrRestricted("::")).toBe(true); // Unspecified
        expect(isIpv6PrivateOrRestricted("fe80::1")).toBe(true); // Link-local
        expect(isIpv6PrivateOrRestricted("fc00::abc")).toBe(true); // Unique-local
        expect(isIpv6PrivateOrRestricted("ff02::1")).toBe(true); // Multicast
        expect(isIpv6PrivateOrRestricted("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped private
        expect(isIpv6PrivateOrRestricted("::ffff:10.0.0.1")).toBe(true); // IPv4-mapped private
    });

    it("identifies safe public IPv6 addresses", () => {
        expect(isIpv6PrivateOrRestricted("2001:4860:4860::8888")).toBe(false);
        expect(isIpv6PrivateOrRestricted("::ffff:8.8.8.8")).toBe(false); // IPv4-mapped public
    });

    it("handles invalid or malformed IPv6s by treating them as restricted", () => {
        expect(isIpv6PrivateOrRestricted("z:::1")).toBe(true);
        expect(isIpv6PrivateOrRestricted("2001:db8::ff00::1")).toBe(true);
    });
});

describe("fetchWithSsrfProtection client checks", () => {
    it("rejects non-http/https protocols", async () => {
        expect(fetchWithSsrfProtection("ftp://example.com")).rejects.toThrow(
            "Unsupported protocol",
        );
        expect(fetchWithSsrfProtection("file:///etc/passwd")).rejects.toThrow(
            "Unsupported protocol",
        );
    });

    it("blocks immediate private IPv4/IPv6 URLs", async () => {
        expect(
            fetchWithSsrfProtection("http://127.0.0.1/health"),
        ).rejects.toThrow("Access to private/restricted IP range blocked");
        expect(fetchWithSsrfProtection("http://[::1]/health")).rejects.toThrow(
            "Access to private/restricted IP range blocked",
        );
        expect(
            fetchWithSsrfProtection("http://10.0.0.1:8080/stats"),
        ).rejects.toThrow("Access to private/restricted IP range blocked");
    });

    it("respects and enforces timeout options", async () => {
        // Safe but non-routable IP to simulate timeout/hang
        expect(
            fetchWithSsrfProtection("http://192.0.2.1", { timeout: 10 }),
        ).rejects.toThrow("Request timed out");
    });
});
