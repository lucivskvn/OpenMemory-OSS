import { describe, expect, it } from "bun:test";
import { extractClientIp } from "../../src/utils/ip";
import { AdvancedRequest } from "../../src/server/server";

describe("IP Resolution Utility", () => {
    it("should return socket address by default when trustProxy is false", () => {
        const req = {
            ip: "10.0.0.5",
            headers: {
                "x-forwarded-for": "1.2.3.4"
            }
        } as unknown as AdvancedRequest;

        expect(extractClientIp(req, false)).toBe("10.0.0.5");
    });

    it("should return the first IP from X-Forwarded-For when trustProxy is true", () => {
        const req = {
            ip: "10.0.0.5",
            headers: {
                "x-forwarded-for": "1.2.3.4, 5.6.7.8"
            }
        } as unknown as AdvancedRequest;

        expect(extractClientIp(req, true)).toBe("1.2.3.4");
    });

    it("should honor CF-Connecting-IP when trustProxy is true", () => {
        const req = {
            ip: "10.0.0.5",
            headers: {
                "cf-connecting-ip": "9.9.9.9",
                "x-forwarded-for": "1.2.3.4"
            }
        } as unknown as AdvancedRequest;

        expect(extractClientIp(req, true)).toBe("9.9.9.9");
    });

    it("should fallback to X-Real-IP if X-Forwarded-For is missing and trustProxy is true", () => {
        const req = {
            ip: "10.0.0.5",
            headers: {
                "x-real-ip": "8.8.8.8"
            }
        } as unknown as AdvancedRequest;

        expect(extractClientIp(req, true)).toBe("8.8.8.8");
    });

    it("should return socket address if no headers match and trustProxy is true", () => {
        const req = {
            ip: "10.0.0.5",
            headers: {}
        } as unknown as AdvancedRequest;

        expect(extractClientIp(req, true)).toBe("10.0.0.5");
    });
});
