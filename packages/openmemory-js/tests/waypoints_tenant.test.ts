process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_EMBEDDING_FALLBACK = "synthetic";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";

import { beforeEach, describe, expect, it } from "bun:test";
import { all_async, q } from "../src/core/db";
import { dynroutes } from "../src/server/routes/dynamics";
import { authenticate_api_request } from "../src/server/middleware/auth";
import { env } from "../src/core/config";

const T_ALICE = "tenant-alice-wp";
const T_BOB = "tenant-bob-wp";

async function cleanup() {
    await all_async(`DELETE FROM memories`);
    await all_async(`DELETE FROM waypoints`);
}

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

const runRoute = async (
    routes: Record<string, Function>,
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
        set: () => res,
        setHeader: () => res,
        status: (code: number) => {
            resStatus = code;
            return res;
        },
        json: (data: any) => {
            resData = data;
            return res;
        },
    };

    return new Promise<{ status: number; data: any }>((resolve, reject) => {
        let handlerStarted = false;
        authenticate_api_request(req, res, async () => {
            handlerStarted = true;
            try {
                await handler(req, res);
                resolve({ status: resStatus, data: resData });
            } catch (error) {
                reject(error);
            }
        });
        if (!handlerStarted) resolve({ status: resStatus, data: resData });
    });
};

describe("Waypoints per-tenant scoping", () => {
    beforeEach(async () => {
        await cleanup();
    });

    it("q.del_waypoints isolates deletions by user_id", async () => {
        const mem_id = "shared-id-123";
        const now = Date.now();

        // Insert waypoints for Alice and Bob
        await q.ins_waypoint.run(mem_id, "dst-alice", T_ALICE, null, 1.0, now, now);
        await q.ins_waypoint.run(mem_id, "dst-bob", T_BOB, null, 1.0, now, now);

        // Verify both waypoints exist
        const all_wps_before = await all_async(`SELECT * FROM waypoints`);
        expect(all_wps_before).toHaveLength(2);

        // Delete waypoints for Alice only
        await q.del_waypoints.run(mem_id, mem_id, T_ALICE);

        // Verify Bob's waypoint still exists
        const wps = await all_async(`SELECT * FROM waypoints`);
        expect(wps).toHaveLength(1);
        expect(wps[0].user_id).toBe(T_BOB);
        expect(wps[0].dst_id).toBe("dst-bob");
    });

    it("POST /dynamics/waypoints/calculate-weight enforces input validation using parse_or_400", async () => {
        const mock = createMockApp();
        dynroutes(mock.app);
        const apiKey = "key-tenant-waypoint-123456789012";

        // 1. Missing body/fields -> 400 Bad Request
        const resMissing = await runRoute(
            mock.routes,
            "POST",
            "/dynamics/waypoints/calculate-weight",
            {},
            {},
            {},
            apiKey,
        );
        expect(resMissing.status).toBe(400);

        // 2. Overly long source_memory_id (>256 chars) -> 400 Bad Request
        const resTooLong = await runRoute(
            mock.routes,
            "POST",
            "/dynamics/waypoints/calculate-weight",
            {},
            {},
            {
                source_memory_id: "a".repeat(300),
                target_memory_id: "b_id",
            },
            apiKey,
        );
        expect(resTooLong.status).toBe(400);
    });
});
