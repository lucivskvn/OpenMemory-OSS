import { describe, it, expect } from "bun:test";
import { compression } from "../src/server/routes/compression";

describe("Compression route scoping and authorization", () => {
    it("enforces tenant verification and role-based permissions on compression endpoints", async () => {
        let compress_handler: any = null;
        let batch_handler: any = null;
        let analyze_handler: any = null;
        let stats_handler: any = null;
        let reset_handler: any = null;

        const app_mock = {
            post: (path: string, handler: any) => {
                if (path === "/api/compression/compress") {
                    compress_handler = handler;
                } else if (path === "/api/compression/batch") {
                    batch_handler = handler;
                } else if (path === "/api/compression/analyze") {
                    analyze_handler = handler;
                } else if (path === "/api/compression/reset") {
                    reset_handler = handler;
                }
            },
            get: (path: string, handler: any) => {
                if (path === "/api/compression/stats") {
                    stats_handler = handler;
                }
            },
        };

        compression(app_mock);
        expect(compress_handler).toBeTruthy();
        expect(batch_handler).toBeTruthy();
        expect(analyze_handler).toBeTruthy();
        expect(stats_handler).toBeTruthy();
        expect(reset_handler).toBeTruthy();

        // 1. Unauthenticated coverage - invoke all handlers without a tenant
        const req_no_tenant = {
            body: {
                text: "Hello",
                texts: ["Hello", "World"],
                algorithm: "semantic",
            },
        };

        const handlers = [
            { name: "compress", handler: compress_handler },
            { name: "batch", handler: batch_handler },
            { name: "analyze", handler: analyze_handler },
            { name: "stats", handler: stats_handler },
            { name: "reset", handler: reset_handler },
        ];

        for (const item of handlers) {
            let status_code = 200;
            let res_json: any = null;
            const res_mock = {
                status: function (code: number) {
                    status_code = code;
                    return this;
                },
                json: (data: any) => {
                    res_json = data;
                },
            };

            await item.handler(req_no_tenant, res_mock);
            expect(status_code).toBe(401);
            expect(res_json.error).toBe("authentication_required");
        }

        // 2. Normal tenant should succeed on compress endpoint
        const req_normal_tenant = {
            tenant: "tenant-alice",
            body: { text: "Hello, this is a beautiful day. We are testing compression.", algorithm: "semantic" },
        };
        let status_code = 200;
        let res_json: any = null;
        const res_mock = {
            status: function (code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                res_json = data;
            },
        };

        await compress_handler(req_normal_tenant, res_mock);
        expect(status_code).toBe(200);
        expect(res_json.ok).toBe(true);

        // 3. Normal tenant should be forbidden from getting stats
        const req_stats_normal = {
            tenant: "tenant-alice",
        };
        status_code = 200;
        res_json = null;

        await stats_handler(req_stats_normal, res_mock);
        expect(status_code).toBe(403);
        expect(res_json.error).toBe("forbidden");

        // 4. Normal tenant should be forbidden from resetting metrics
        const req_reset_normal = {
            tenant: "tenant-alice",
        };
        status_code = 200;
        res_json = null;

        await reset_handler(req_reset_normal, res_mock);
        expect(status_code).toBe(403);
        expect(res_json.error).toBe("forbidden");

        // 5. Admin tenant should succeed on getting stats
        const req_stats_admin = {
            tenant: "admin",
        };
        status_code = 200;
        res_json = null;

        await stats_handler(req_stats_admin, res_mock);
        expect(status_code).toBe(200);
        expect(res_json.ok).toBe(true);

        // 6. Admin tenant should succeed on resetting metrics
        const req_reset_admin = {
            tenant: "admin",
        };
        status_code = 200;
        res_json = null;

        await reset_handler(req_reset_admin, res_mock);
        expect(status_code).toBe(200);
        expect(res_json.ok).toBe(true);
    });
});
