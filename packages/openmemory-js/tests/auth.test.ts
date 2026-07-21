import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { authenticate_api_request } from "../src/server/middleware/auth";
import { env } from "../src/core/config";

describe("Authentication Middleware", () => {
    let original_api_key: string | undefined;

    beforeAll(() => {
        original_api_key = env.api_key;
        env.api_key = "test-secret-api-key-999";
    });

    afterAll(() => {
        env.api_key = original_api_key;
    });

    it("allows request with a valid x-api-key header", () => {
        const req: any = {
            path: "/api/memory",
            headers: {
                "x-api-key": "test-secret-api-key-999",
            },
        };
        let next_called = false;
        const res: any = {
            status: () => res,
            json: () => res,
        };

        authenticate_api_request(req, res, () => {
            next_called = true;
        });

        expect(next_called).toBe(true);
        expect(req.tenant).toBeDefined();
        expect(req.tenant).toHaveLength(16);
    });

    it("allows request with a valid Authorization Bearer token", () => {
        const req: any = {
            path: "/api/memory",
            headers: {
                authorization: "Bearer test-secret-api-key-999",
            },
        };
        let next_called = false;
        const res: any = {
            status: () => res,
            json: () => res,
        };

        authenticate_api_request(req, res, () => {
            next_called = true;
        });

        expect(next_called).toBe(true);
    });

    it("allows request with a valid Authorization ApiKey token", () => {
        const req: any = {
            path: "/api/memory",
            headers: {
                authorization: "ApiKey test-secret-api-key-999",
            },
        };
        let next_called = false;
        const res: any = {
            status: () => res,
            json: () => res,
        };

        authenticate_api_request(req, res, () => {
            next_called = true;
        });

        expect(next_called).toBe(true);
    });

    it("rejects request with a missing API key (401)", () => {
        const req: any = {
            path: "/api/memory",
            headers: {},
        };
        let next_called = false;
        let status_val = 0;
        let json_val: any = null;
        const res: any = {
            status: (s: number) => {
                status_val = s;
                return res;
            },
            json: (j: any) => {
                json_val = j;
                return res;
            },
        };

        authenticate_api_request(req, res, () => {
            next_called = true;
        });

        expect(next_called).toBe(false);
        expect(status_val).toBe(401);
        expect(json_val?.error).toBe("authentication_required");
    });

    it("rejects request with a key of incorrect length (403)", () => {
        const req: any = {
            path: "/api/memory",
            headers: {
                "x-api-key": "short",
            },
        };
        let next_called = false;
        let status_val = 0;
        let json_val: any = null;
        const res: any = {
            status: (s: number) => {
                status_val = s;
                return res;
            },
            json: (j: any) => {
                json_val = j;
                return res;
            },
        };

        authenticate_api_request(req, res, () => {
            next_called = true;
        });

        expect(next_called).toBe(false);
        expect(status_val).toBe(403);
        expect(json_val?.error).toBe("invalid_api_key");
    });

    it("rejects request with a key of correct length but incorrect content (403)", () => {
        const req: any = {
            path: "/api/memory",
            headers: {
                "x-api-key": "test-secret-api-key-888", // same length as 999
            },
        };
        let next_called = false;
        let status_val = 0;
        let json_val: any = null;
        const res: any = {
            status: (s: number) => {
                status_val = s;
                return res;
            },
            json: (j: any) => {
                json_val = j;
                return res;
            },
        };

        authenticate_api_request(req, res, () => {
            next_called = true;
        });

        expect(next_called).toBe(false);
        expect(status_val).toBe(403);
        expect(json_val?.error).toBe("invalid_api_key");
    });

    it("allows access to public endpoints without any API key", () => {
        const req: any = {
            path: "/health",
            headers: {},
        };
        let next_called = false;
        const res: any = {
            status: () => res,
            json: () => res,
        };

        authenticate_api_request(req, res, () => {
            next_called = true;
        });

        expect(next_called).toBe(true);
    });

    it("dynamically updates configuration when env.api_key changes", () => {
        // Change the api key dynamically
        env.api_key = "brand-new-dynamic-key-777";

        // Try with old key - should fail
        const req_old: any = {
            path: "/api/memory",
            headers: {
                "x-api-key": "test-secret-api-key-999",
            },
        };
        let next_called_old = false;
        let status_val_old = 0;
        const res_old: any = {
            status: (s: number) => {
                status_val_old = s;
                return res_old;
            },
            json: () => res_old,
        };

        authenticate_api_request(req_old, res_old, () => {
            next_called_old = true;
        });

        expect(next_called_old).toBe(false);
        expect(status_val_old).toBe(403);

        // Try with new key - should pass
        const req_new: any = {
            path: "/api/memory",
            headers: {
                "x-api-key": "brand-new-dynamic-key-777",
            },
        };
        let next_called_new = false;
        const res_new: any = {
            status: () => res_new,
            json: () => res_new,
        };

        authenticate_api_request(req_new, res_new, () => {
            next_called_new = true;
        });

        expect(next_called_new).toBe(true);
    });
});
