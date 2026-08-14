import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { authenticate_api_request } from "../src/server/middleware/auth";
import { env } from "../src/core/config";
import { dash } from "../src/server/routes/dashboard";

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

    it("allows access to webhook endpoints without any API key", () => {
        const req1: any = {
            path: "/sources/webhook/github",
            headers: {},
        };
        const req2: any = {
            path: "/sources/webhook/notion",
            headers: {},
        };
        let next_called1 = false;
        let next_called2 = false;
        const res: any = {
            status: () => res,
            json: () => res,
        };

        authenticate_api_request(req1, res, () => {
            next_called1 = true;
        });
        authenticate_api_request(req2, res, () => {
            next_called2 = true;
        });

        expect(next_called1).toBe(true);
        expect(next_called2).toBe(true);
    });

    it("does NOT exempt partial prefix paths from API key checks (prevents authentication bypass)", () => {
        const paths = [
            "/health-secrets",
            "/api/system/health-secrets",
            "/dashboard/health-secrets",
        ];

        for (const p of paths) {
            const req: any = {
                path: p,
                headers: {},
            };
            let next_called = false;
            let status_val = 0;
            const res: any = {
                status: (s: number) => {
                    status_val = s;
                    return res;
                },
                json: () => res,
            };

            authenticate_api_request(req, res, () => {
                next_called = true;
            });

            expect(next_called).toBe(false);
            expect(status_val).toBe(401); // Requires API key
        }
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

    it("rejects access to /dashboard/health without valid authentication", () => {
        const req: any = {
            path: "/dashboard/health",
            headers: {},
        };
        let next_called = false;
        let status_val = 0;
        const res: any = {
            status: (s: number) => {
                status_val = s;
                return res;
            },
            json: () => res,
        };

        authenticate_api_request(req, res, () => {
            next_called = true;
        });

        expect(next_called).toBe(false);
        expect(status_val).toBe(401); // Requires API key
    });

    it("enforces require_tenant and is_admin_tenant on /dashboard/health route", async () => {
        let health_handler: any = null;
        const app_mock = {
            get: (path: string, handler: any) => {
                if (path === "/dashboard/health") {
                    health_handler = handler;
                }
            },
            post: () => {},
        };

        dash(app_mock);
        expect(health_handler).toBeTruthy();

        // 1. Missing tenant (should return 401)
        const req_no_tenant = {};
        let status_code = 200;
        let res_json: any = null;
        const res_no_tenant = {
            status: function (code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                res_json = data;
            },
        };

        await health_handler(req_no_tenant, res_no_tenant);
        expect(status_code).toBe(401);
        expect(res_json.error).toBe("authentication_required");

        // 2. Authenticated non-administrator tenant (should return 403)
        const req_non_admin = {
            tenant: "tenant-alice",
        };
        let status_code_non_admin = 200;
        let res_json_non_admin: any = null;
        const res_non_admin = {
            status: function (code: number) {
                status_code_non_admin = code;
                return this;
            },
            json: (data: any) => {
                res_json_non_admin = data;
            },
        };

        await health_handler(req_non_admin, res_non_admin);
        expect(status_code_non_admin).toBe(403);
        expect(res_json_non_admin.error).toBe("forbidden");

        // 3. Authenticated administrator tenant (should return 200)
        const req_admin = {
            tenant: "admin",
        };
        let status_code_admin = 200;
        let res_json_admin: any = null;
        const res_admin = {
            status: function (code: number) {
                status_code_admin = code;
                return this;
            },
            json: (data: any) => {
                res_json_admin = data;
            },
        };

        await health_handler(req_admin, res_admin);
        expect(status_code_admin).toBe(200);
        expect(res_json_admin).toBeTruthy();
        expect(res_json_admin.memory).toBeDefined();
        expect(res_json_admin.process).toBeDefined();
    });
});
