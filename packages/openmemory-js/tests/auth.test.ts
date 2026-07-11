import { describe, it, expect, beforeAll } from "bun:test";
import { env } from "../src/core/config";

beforeAll(() => {
    env.api_key = "super-secret-test-api-key-123456789";
});

import { authenticate_api_request } from "../src/server/middleware/auth";

describe("API Authentication Middleware", () => {
    const mockResponse = () => {
        const res: any = {};
        res.status_code = 200;
        res.headers = {} as Record<string, any>;
        res.status = (code: number) => {
            res.status_code = code;
            return res;
        };
        res.json = (data: any) => {
            res.json_data = data;
            return res;
        };
        res.setHeader = (name: string, value: any) => {
            res.headers[name] = value;
            return res;
        };
        return res;
    };

    it("should allow public endpoints without auth", () => {
        const req = {
            url: "/health",
            headers: {},
        };
        const res = mockResponse();
        let nextCalled = false;
        const next = () => {
            nextCalled = true;
        };

        authenticate_api_request(req, res, next);
        expect(nextCalled).toBe(true);
    });

    it("should reject requests without API key on protected endpoints", () => {
        const req = {
            url: "/api/memory/all",
            headers: {},
        };
        const res = mockResponse();
        let nextCalled = false;
        const next = () => {
            nextCalled = true;
        };

        authenticate_api_request(req, res, next);
        expect(nextCalled).toBe(false);
        expect(res.status_code).toBe(401);
        expect(res.json_data.error).toBe("authentication_required");
    });

    it("should accept requests with valid API key via x-api-key header", () => {
        const req = {
            url: "/api/memory/all",
            headers: {
                "x-api-key": "super-secret-test-api-key-123456789",
            },
        };
        const res = mockResponse();
        let nextCalled = false;
        const next = () => {
            nextCalled = true;
        };

        authenticate_api_request(req, res, next);
        expect(nextCalled).toBe(true);
        expect((req as any).tenant).toBeDefined();
        expect(typeof (req as any).tenant).toBe("string");
    });

    it("should accept requests with valid API key via Authorization Bearer header", () => {
        const req = {
            url: "/api/memory/all",
            headers: {
                authorization: "Bearer super-secret-test-api-key-123456789",
            },
        };
        const res = mockResponse();
        let nextCalled = false;
        const next = () => {
            nextCalled = true;
        };

        authenticate_api_request(req, res, next);
        expect(nextCalled).toBe(true);
        expect((req as any).tenant).toBeDefined();
    });

    it("should reject requests with invalid API key", () => {
        const req = {
            url: "/api/memory/all",
            headers: {
                "x-api-key": "wrong-key",
            },
        };
        const res = mockResponse();
        let nextCalled = false;
        const next = () => {
            nextCalled = true;
        };

        authenticate_api_request(req, res, next);
        expect(nextCalled).toBe(false);
        expect(res.status_code).toBe(403);
        expect(res.json_data.error).toBe("invalid_api_key");
    });

    it("should reject requests with invalid API key of the same length", () => {
        const req = {
            url: "/api/memory/all",
            headers: {
                "x-api-key": "super-secret-test-api-key-12345678a",
            },
        };
        const res = mockResponse();
        let nextCalled = false;
        const next = () => {
            nextCalled = true;
        };

        authenticate_api_request(req, res, next);
        expect(nextCalled).toBe(false);
        expect(res.status_code).toBe(403);
        expect(res.json_data.error).toBe("invalid_api_key");
    });
});
