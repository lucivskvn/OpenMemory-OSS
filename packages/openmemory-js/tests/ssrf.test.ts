import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { isIpPrivateOrRestricted, isSafeUrl, fetchWithSsrfProtection } from "../src/utils/fetch";
import { extractURL } from "../src/ops/extract";
import dns from "node:dns/promises";
import http from "node:http";

// Mock dns.lookup for fictional safe domains used in testing redirects
const originalLookup = dns.lookup;
beforeAll(() => {
    dns.lookup = mock((hostname: string, options?: any) => {
        if (hostname === "safe-domain.com" || hostname === "another-safe-domain.com") {
            return Promise.resolve([{ address: "8.8.8.8", family: 4 }]);
        }
        return originalLookup(hostname, options);
    }) as any;
});

afterAll(() => {
    dns.lookup = originalLookup;
});

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

    it("identifies IPv4 carrier-grade NAT block as restricted", () => {
        expect(isIpPrivateOrRestricted("100.64.0.1")).toBe(true);
        expect(isIpPrivateOrRestricted("100.127.255.255")).toBe(true);
        expect(isIpPrivateOrRestricted("100.128.0.1")).toBe(false);
    });

    it("identifies IPv4 link-local (AWS metadata) as restricted", () => {
        expect(isIpPrivateOrRestricted("169.254.169.254")).toBe(true);
    });

    it("identifies IPv6 loopback and restricted ranges", () => {
        expect(isIpPrivateOrRestricted("::1")).toBe(true);
        expect(isIpPrivateOrRestricted("fe80::1")).toBe(true);
        expect(isIpPrivateOrRestricted("fe90::1")).toBe(true);
        expect(isIpPrivateOrRestricted("fc00::1")).toBe(true);
        expect(isIpPrivateOrRestricted("fd12::1")).toBe(true);
        expect(isIpPrivateOrRestricted("ff00::1")).toBe(true);
        expect(isIpPrivateOrRestricted("ff02::1")).toBe(true);
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
    it("rejects non-http/https protocols", async () => {
        await expect(isSafeUrl("ftp://8.8.8.8")).resolves.toBe(false);
        await expect(isSafeUrl("gopher://8.8.8.8")).resolves.toBe(false);
        await expect(isSafeUrl("file:///etc/passwd")).resolves.toBe(false);
    });

    it("rejects loopback and private IP URLs", async () => {
        await expect(isSafeUrl("http://127.0.0.1")).resolves.toBe(false);
        await expect(isSafeUrl("https://10.0.0.1/health")).resolves.toBe(false);
        await expect(isSafeUrl("http://[::1]")).resolves.toBe(false);
        await expect(isSafeUrl("http://169.254.169.254/latest/meta-data/")).resolves.toBe(false);
    });

    it("rejects hostnames resolving to private IPs (localhost)", async () => {
        await expect(isSafeUrl("http://localhost")).resolves.toBe(false);
    });

    it("allows safe public URLs", async () => {
        await expect(isSafeUrl("https://safe-domain.com")).resolves.toBe(true);
        await expect(isSafeUrl("https://another-safe-domain.com")).resolves.toBe(true);
    });
});

describe("extractURL SSRF integration", () => {
    it("throws an error for unsafe URLs in extractURL", async () => {
        await expect(extractURL("http://127.0.0.1:3000/api")).rejects.toThrow("SSRF Prevention");
        await expect(extractURL("http://localhost/stats")).rejects.toThrow("SSRF Prevention");
    });
});

describe("fetchWithSsrfProtection Redirects & Rebinding", () => {
    it("follows safe redirects", async () => {
        const originalRequest = http.request;
        const calls: string[] = [];

        http.request = mock((options: any, callback: any) => {
            const hostHeader = options.headers?.Host || options.headers?.host || "";
            const isAnother = hostHeader.includes("another");
            const urlStr = `http://${isAnother ? "another-safe-domain.com" : "safe-domain.com"}${options.path}`;
            calls.push(urlStr);

            const mockRes: any = {
                statusCode: isAnother ? 200 : 302,
                headers: {
                    "location": "http://another-safe-domain.com/path"
                },
                on: (event: string, cb: any) => {
                    if (event === "data") {
                        setTimeout(() => cb(Buffer.from("success")), 0);
                    }
                    if (event === "end") {
                        setTimeout(cb, 5);
                    }
                }
            };
            setTimeout(() => callback(mockRes), 0);
            return {
                on: () => {},
                end: () => {},
            } as any;
        }) as any;

        try {
            const res = await fetchWithSsrfProtection("http://safe-domain.com/path");
            expect(await res.text()).toBe("success");
            expect(calls).toEqual(["http://safe-domain.com/path", "http://another-safe-domain.com/path"]);
        } finally {
            http.request = originalRequest;
        }
    });

    it("blocks redirects to unsafe URLs", async () => {
        const originalRequest = http.request;
        http.request = mock((options: any, callback: any) => {
            const mockRes: any = {
                statusCode: 302,
                headers: {
                    "location": "http://127.0.0.1/path"
                },
                on: (event: string, cb: any) => {
                    if (event === "end") setTimeout(cb, 0);
                }
            };
            setTimeout(() => callback(mockRes), 0);
            return {
                on: () => {},
                end: () => {},
            } as any;
        }) as any;

        try {
            await expect(fetchWithSsrfProtection("http://safe-domain.com/path")).rejects.toThrow("SSRF Prevention: Unsafe IP address");
        } finally {
            http.request = originalRequest;
        }
    });

    it("prevents DNS rebinding by pinning the validated IP address", async () => {
        const originalRequest = http.request;
        let requestedHost = "";

        http.request = mock((options: any, callback: any) => {
            requestedHost = options.hostname; // This should be the pinned IP, NOT the domain name!
            const mockRes: any = {
                statusCode: 200,
                headers: {},
                on: (event: string, cb: any) => {
                    if (event === "end") setTimeout(cb, 0);
                }
            };
            setTimeout(() => callback(mockRes), 0);
            return {
                on: () => {},
                end: () => {},
            } as any;
        }) as any;

        try {
            await fetchWithSsrfProtection("http://safe-domain.com/path");
            // The request should have been sent directly to the pinned IP (8.8.8.8), preventing TOCTOU rebinding!
            expect(requestedHost).toBe("8.8.8.8");
        } finally {
            http.request = originalRequest;
        }
    });
});
