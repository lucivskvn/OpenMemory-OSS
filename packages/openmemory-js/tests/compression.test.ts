import { describe, it, expect, spyOn } from "bun:test";
import express from "express";
import { compression } from "../src/server/routes/compression";
import { dash } from "../src/server/routes/dashboard";
import { compressionEngine } from "../src/ops/compress";
import * as dbModule from "../src/core/db";

describe("Compression routes tenant scoping and admin check", () => {
    // 1. Setup route handlers mock
    let compress_handler: any = null;
    let batch_handler: any = null;
    let analyze_handler: any = null;
    let stats_handler: any = null;
    let reset_handler: any = null;

    const app_mock = {
        post: (path: string, handler: any) => {
            if (path === "/api/compression/compress") compress_handler = handler;
            else if (path === "/api/compression/batch") batch_handler = handler;
            else if (path === "/api/compression/analyze") analyze_handler = handler;
            else if (path === "/api/compression/reset") reset_handler = handler;
        },
        get: (path: string, handler: any) => {
            if (path === "/api/compression/stats") stats_handler = handler;
        },
    };

    compression(app_mock);

    it("ensures all handlers are registered correctly", () => {
        expect(compress_handler).toBeTruthy();
        expect(batch_handler).toBeTruthy();
        expect(analyze_handler).toBeTruthy();
        expect(stats_handler).toBeTruthy();
        expect(reset_handler).toBeTruthy();
    });

    it("rejects requests without a tenant (401)", async () => {
        const handlers = [
            compress_handler,
            batch_handler,
            analyze_handler,
            stats_handler,
            reset_handler,
        ];

        for (const handler of handlers) {
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

            await handler({}, res_mock);
            expect(status_code).toBe(401);
            expect(res_json?.error).toBe("authentication_required");
        }
    });

    it("allows standard tenant to call core compression endpoints", async () => {
        const req_mock = {
            tenant: "tenant-alice",
            body: {
                text: "Hello, this is standard memory compression text.",
                texts: ["Hello", "World"],
            },
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
                return this;
            },
        };

        // Core compress
        await compress_handler(req_mock, res_mock);
        expect(res_json?.ok).toBe(true);

        // Core batch
        await batch_handler(req_mock, res_mock);
        expect(res_json?.ok).toBe(true);

        // Core analyze
        await analyze_handler(req_mock, res_mock);
        expect(res_json?.ok).toBe(true);
    });

    it("blocks standard tenant from calling admin endpoints (403)", async () => {
        const req_mock = {
            tenant: "tenant-alice",
        };

        const admin_handlers = [stats_handler, reset_handler];

        for (const handler of admin_handlers) {
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

            await handler(req_mock, res_mock);
            expect(status_code).toBe(403);
            expect(res_json?.error).toBe("forbidden");
        }
    });

    it("allows admin/system/dev-no-auth tenants to call admin endpoints", async () => {
        const admin_tenants = ["admin", "system", "dev-no-auth"];

        for (const tenant of admin_tenants) {
            const req_mock = {
                tenant,
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

            // stats
            await stats_handler(req_mock, res_mock);
            expect(status_code).toBe(200);
            expect(res_json?.ok).toBe(true);
            expect(res_json?.stats).toBeDefined();

            // reset
            await reset_handler(req_mock, res_mock);
            expect(status_code).toBe(200);
            expect(res_json?.ok).toBe(true);
            expect(res_json?.msg).toBe("reset done");
        }
    });

    it("enforces validation limits on inputs to prevent DoS", async () => {
        const create_res_mock = () => {
            let status_code = 200;
            let res_json: any = null;
            return {
                status: function (code: number) {
                    status_code = code;
                    return this;
                },
                set: function (key: string, val: string) {
                    return this;
                },
                json: function (data: any) {
                    res_json = data;
                    return this;
                },
                get_status: () => status_code,
                get_json: () => res_json,
            };
        };

        // 1. Text is too long (> 200,000 characters)
        const huge_text = "A".repeat(200_001);
        const req_huge = {
            tenant: "tenant-alice",
            body: { text: huge_text },
        };
        const res_huge = create_res_mock();
        await compress_handler(req_huge, res_huge);
        expect(res_huge.get_status()).toBe(400);
        expect(res_huge.get_json()?.title).toBe("Invalid Input");

        // 2. Text is empty
        const req_empty = {
            tenant: "tenant-alice",
            body: { text: "" },
        };
        const res_empty = create_res_mock();
        await compress_handler(req_empty, res_empty);
        expect(res_empty.get_status()).toBe(400);

        // 3. Batch texts is too large (> 100 items)
        const req_huge_batch = {
            tenant: "tenant-alice",
            body: { texts: Array(101).fill("hello") },
        };
        const res_huge_batch = create_res_mock();
        await batch_handler(req_huge_batch, res_huge_batch);
        expect(res_huge_batch.get_status()).toBe(400);

        // 4. Batch texts has elements too long
        const req_huge_element_batch = {
            tenant: "tenant-alice",
            body: { texts: [huge_text] },
        };
        const res_huge_element_batch = create_res_mock();
        await batch_handler(req_huge_element_batch, res_huge_element_batch);
        expect(res_huge_element_batch.get_status()).toBe(400);

        // 5. Invalid algorithm for compress
        const req_invalid_algo = {
            tenant: "tenant-alice",
            body: { text: "hello", algorithm: "super-extreme" },
        };
        const res_invalid_algo = create_res_mock();
        await compress_handler(req_invalid_algo, res_invalid_algo);
        expect(res_invalid_algo.get_status()).toBe(400);

        // 6. Invalid algorithm for batch
        const req_invalid_batch_algo = {
            tenant: "tenant-alice",
            body: { texts: ["hello"], algorithm: "super-extreme" },
        };
        const res_invalid_batch_algo = create_res_mock();
        await batch_handler(req_invalid_batch_algo, res_invalid_batch_algo);
        expect(res_invalid_batch_algo.get_status()).toBe(400);

        // 7. Empty text for analyze
        const req_analyze_empty = {
            tenant: "tenant-alice",
            body: { text: "" },
        };
        const res_analyze_empty = create_res_mock();
        await analyze_handler(req_analyze_empty, res_analyze_empty);
        expect(res_analyze_empty.get_status()).toBe(400);

        // 8. Oversized text for analyze
        const req_analyze_huge = {
            tenant: "tenant-alice",
            body: { text: huge_text },
        };
        const res_analyze_huge = create_res_mock();
        await analyze_handler(req_analyze_huge, res_analyze_huge);
        expect(res_analyze_huge.get_status()).toBe(400);
    });

    it("sanitizes 500 error responses and prevents raw exception leakage", async () => {
        const orig_auto = compressionEngine.auto;
        const orig_batch = compressionEngine.batch;
        const orig_analyze = compressionEngine.analyze;
        const orig_stats = compressionEngine.getStats;
        const orig_reset = compressionEngine.reset;
        const orig_console_error = console.error;

        const logged_errors: any[][] = [];
        console.error = (...args: any[]) => {
            logged_errors.push(args);
        };

        const secret_error_msg = "SENSITIVE_DB_CREDENTIALS_AND_INTERNAL_STACK_TRACE";

        try {
            compressionEngine.auto = () => {
                throw new Error(secret_error_msg);
            };
            compressionEngine.batch = () => {
                throw new Error(secret_error_msg);
            };
            compressionEngine.analyze = () => {
                throw new Error(secret_error_msg);
            };
            compressionEngine.getStats = () => {
                throw new Error(secret_error_msg);
            };
            compressionEngine.reset = () => {
                throw new Error(secret_error_msg);
            };

            const test_cases = [
                { name: "compress", handler: compress_handler, req: { tenant: "tenant-alice", body: { text: "hello" } } },
                { name: "batch", handler: batch_handler, req: { tenant: "tenant-alice", body: { texts: ["hello"] } } },
                { name: "analyze", handler: analyze_handler, req: { tenant: "tenant-alice", body: { text: "hello" } } },
                { name: "stats", handler: stats_handler, req: { tenant: "admin" } },
                { name: "reset", handler: reset_handler, req: { tenant: "admin" } },
            ];

            for (const tc of test_cases) {
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

                await tc.handler(tc.req, res_mock);
                expect(status_code).toBe(500);
                expect(res_json?.error).toBe("Compression processing failed");
                expect(JSON.stringify(res_json)).not.toContain(secret_error_msg);
            }

            expect(logged_errors).toHaveLength(test_cases.length);
            for (let i = 0; i < test_cases.length; i++) {
                expect(logged_errors[i][0]).toContain(`[compression] ${test_cases[i].name} error:`);
            }
        } finally {
            compressionEngine.auto = orig_auto;
            compressionEngine.batch = orig_batch;
            compressionEngine.analyze = orig_analyze;
            compressionEngine.getStats = orig_stats;
            compressionEngine.reset = orig_reset;
            console.error = orig_console_error;
        }
    });

    it("sanitizes 500 responses on dashboard routes without leaking e.message", async () => {
        const d_app = express();
        d_app.use((req: any, _r: any, next: any) => {
            req.tenant = "admin";
            next();
        });
        dash(d_app);

        const spy = spyOn(dbModule, "all_async").mockImplementation(() => {
            throw new Error("SECRET_DB_LEAK: postgres://admin:pass@127.0.0.1:5432/db");
        });
        const console_spy = spyOn(console, "error").mockImplementation(() => {});
        let server: ReturnType<typeof d_app.listen> | undefined;

        try {
            server = d_app.listen(0);
            const port = (server.address() as any).port;
            const routes = [
                "/dashboard/projects",
                "/dashboard/stats",
                "/dashboard/activity",
                "/dashboard/sectors/timeline",
                "/dashboard/top-memories",
                "/dashboard/maintenance",
            ];

            for (const path of routes) {
                const res = await fetch(`http://localhost:${port}${path}`);
                expect(res.status).toBe(500);
                const data = await res.json();
                expect(data).toEqual({ err: "internal" });
            }
            expect(JSON.stringify(console_spy.mock.calls)).not.toContain("SECRET_DB_LEAK");
        } finally {
            try {
                if (server) {
                    await new Promise<void>((resolve, reject) => {
                        server.close((error) => (error ? reject(error) : resolve()));
                    });
                }
            } finally {
                spy.mockRestore();
                console_spy.mockRestore();
            }
        }
    });
});
