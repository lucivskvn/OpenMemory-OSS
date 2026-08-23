import { describe, test, expect, beforeAll } from "bun:test";
import { init_db, q } from "../src/core/db";
import { ide } from "../src/server/routes/ide";
import { authenticate_api_request } from "../src/server/middleware/auth";
import { env } from "../src/core/config";
import crypto from "crypto";

const createMockApp = () => {
    const routes: Record<string, Function> = {};
    const app = {
        get: (path: string, handler: Function) => {
            routes[`GET:${path}`] = handler;
        },
        post: (path: string, handler: Function) => {
            routes[`POST:${path}`] = handler;
        },
    };
    return { app, routes };
};

describe("IDE routes per-tenant isolation & input validation", () => {
    let routes: Record<string, Function>;

    beforeAll(async () => {
        await init_db();
        await q.clear_all.run();
        const mock = createMockApp();
        ide(mock.app);
        routes = mock.routes;
    });

    const runRoute = async (
        method: "GET" | "POST",
        pathPattern: string,
        params: Record<string, string>,
        query: Record<string, any>,
        body: any,
        apiKey: string,
    ) => {
        const handler = routes[`${method}:${pathPattern}`];
        if (!handler) throw new Error(`Route not found: ${method}:${pathPattern}`);

        let resStatus = 200;
        let resData: any = null;

        env.api_key = apiKey;

        const req = {
            method,
            path: pathPattern,
            url: pathPattern,
            headers: { "x-api-key": apiKey },
            params,
            query,
            body,
        };

        const res = {
            setHeader: () => {},
            status: (code: number) => {
                resStatus = code;
                return res;
            },
            json: (data: any) => {
                resData = data;
                return res;
            },
        };

        return new Promise<{ status: number; data: any }>((resolve) => {
            let handlerStarted = false;
            authenticate_api_request(req, res, async () => {
                handlerStarted = true;
                await handler(req, res);
                resolve({ status: resStatus, data: resData });
            });
            if (!handlerStarted) resolve({ status: resStatus, data: resData });
        });
    };

    test("GET /api/ide/patterns/:session_id rejects invalid or overly long session_id", async () => {
        const key = "test-api-key-12345678901234567890";

        // Overly long session_id (>256 chars)
        const longSessionId = "s".repeat(257);
        const resLong = await runRoute(
            "GET",
            "/api/ide/patterns/:session_id",
            { session_id: longSessionId },
            {},
            {},
            key,
        );
        expect(resLong.status).toBe(400);
        expect(resLong.data).toEqual({ err: "invalid_session_id" });
    });

    test("GET /api/ide/patterns/:session_id enforces multi-tenant isolation and database-level sector filtering", async () => {
        const keyA = "key-tenant-a-12345678901234567890";
        const keyB = "key-tenant-b-12345678901234567890";

        const tenantA = crypto.createHash("sha256").update(keyA).digest("hex").slice(0, 16);
        const tenantB = crypto.createHash("sha256").update(keyB).digest("hex").slice(0, 16);

        const sessionId = "session_test_456";

        // Insert a procedural memory belonging to tenantA
        await q.ins_mem.run(
            "mem_ide_pattern_a",
            tenantA,
            "proj_1",
            0,
            "Refactored user auth pattern in auth.ts",
            "simhash1",
            "procedural",
            JSON.stringify(["ide"]),
            JSON.stringify({ ide_session_id: sessionId }),
            Date.now(),
            Date.now(),
            Date.now(),
            1.0,
            0.01,
            1,
            null,
            null,
            null,
            0,
        );

        // Insert a non-procedural memory belonging to tenantA with same session_id
        await q.ins_mem.run(
            "mem_ide_semantic_a",
            tenantA,
            "proj_1",
            0,
            "Semantic memory about code design",
            "simhash2",
            "semantic",
            JSON.stringify(["ide"]),
            JSON.stringify({ ide_session_id: sessionId }),
            Date.now(),
            Date.now(),
            Date.now(),
            1.0,
            0.01,
            1,
            null,
            null,
            null,
            0,
        );

        // Tenant A queries patterns for sessionId -> receives 1 pattern
        const resA = await runRoute(
            "GET",
            "/api/ide/patterns/:session_id",
            { session_id: sessionId },
            {},
            {},
            keyA,
        );
        expect(resA.status).toBe(200);
        expect(resA.data.success).toBe(true);
        expect(resA.data.pattern_count).toBe(1);
        expect(resA.data.patterns[0].pattern_id).toBe("mem_ide_pattern_a");

        // Tenant B queries patterns for the same sessionId -> receives 0 patterns (isolated)
        const resB = await runRoute(
            "GET",
            "/api/ide/patterns/:session_id",
            { session_id: sessionId },
            {},
            {},
            keyB,
        );
        expect(resB.status).toBe(200);
        expect(resB.data.success).toBe(true);
        expect(resB.data.pattern_count).toBe(0);
        expect(resB.data.patterns).toEqual([]);
    });
});
