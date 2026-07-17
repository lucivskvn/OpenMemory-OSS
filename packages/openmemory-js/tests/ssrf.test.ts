import { describe, it, expect } from "bun:test";
import { isIpPrivateOrRestricted, isSafeUrl } from "../src/utils/fetch";
import { extractURL } from "../src/ops/extract";

describe("SSRF IP range checks", () => {
    it("identifies IPv4 loopback as restricted", () => {
        expect(isIpPrivateOrRestricted("127.0.0.1")).toBe(true);
        expect(isIpPrivateOrRestricted("127.255.255.255")).toBe(true);
    });

    it("identifies IPv4 private subnets as restricted", () => {
        // 10.0.0.0/8
        expect(isIpPrivateOrRestricted("10.0.0.1")).toBe(true);
        // 172.16.0.0/12
        expect(isIpPrivateOrRestricted("172.16.0.1")).toBe(true);
        expect(isIpPrivateOrRestricted("172.31.255.255")).toBe(true);
        expect(isIpPrivateOrRestricted("172.32.0.1")).toBe(false);
        // 192.168.0.0/16
        expect(isIpPrivateOrRestricted("192.168.1.1")).toBe(true);
    });

    it("identifies IPv4 link-local (AWS metadata) as restricted", () => {
        expect(isIpPrivateOrRestricted("169.254.169.254")).toBe(true);
    });

    it("identifies IPv6 loopback and restricted ranges", () => {
        expect(isIpPrivateOrRestricted("::1")).toBe(true);
        expect(isIpPrivateOrRestricted("fe80::1")).toBe(true);
        expect(isIpPrivateOrRestricted("fc00::1")).toBe(true);
        expect(isIpPrivateOrRestricted("fd00::1")).toBe(true);
        expect(isIpPrivateOrRestricted("ff00::1")).toBe(true);
    });

    it("identifies IPv4-mapped IPv6 restricted addresses", () => {
        expect(isIpPrivateOrRestricted("::ffff:127.0.0.1")).toBe(true);
        expect(isIpPrivateOrRestricted("::ffff:10.0.0.1")).toBe(true);
        expect(isIpPrivateOrRestricted("::ffff:8.8.8.8")).toBe(false);
    });

    it("allows public safe IPs", () => {
        expect(isIpPrivateOrRestricted("8.8.8.8")).toBe(false);
        expect(isIpPrivateOrRestricted("1.1.1.1")).toBe(false);
    });
});

describe("SSRF URL safety validation", () => {
    it("rejects non-http/https protocols", () => {
        expect(isSafeUrl("ftp://8.8.8.8")).resolves.toBe(false);
        expect(isSafeUrl("gopher://8.8.8.8")).resolves.toBe(false);
        expect(isSafeUrl("file:///etc/passwd")).resolves.toBe(false);
    });

    it("rejects loopback and private IP URLs", () => {
        expect(isSafeUrl("http://127.0.0.1")).resolves.toBe(false);
        expect(isSafeUrl("https://10.0.0.1/health")).resolves.toBe(false);
        expect(isSafeUrl("http://[::1]")).resolves.toBe(false);
        expect(isSafeUrl("http://169.254.169.254/latest/meta-data/")).resolves.toBe(false);
    });

    it("rejects hostnames resolving to private IPs (localhost)", () => {
        expect(isSafeUrl("http://localhost")).resolves.toBe(false);
    });

    it("allows safe public URLs", () => {
        expect(isSafeUrl("https://google.com")).resolves.toBe(true);
        expect(isSafeUrl("https://github.com/CaviraOSS/OpenMemory")).resolves.toBe(true);
    });
});

describe("extractURL SSRF integration", () => {
    it("throws an error for unsafe URLs in extractURL", async () => {
        expect(extractURL("http://127.0.0.1:3000/api")).rejects.toThrow("URL is not safe/allowed");
        expect(extractURL("http://localhost/stats")).rejects.toThrow("URL is not safe/allowed");
    });
});
