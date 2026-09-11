process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_EMBEDDING_FALLBACK = "synthetic";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";

import { beforeEach, describe, expect, it } from "bun:test";
import { all_async, q } from "../src/core/db";
import { dynroutes } from "../src/server/routes/dynamics";

const T_ALICE = "tenant-alice-wp";
const T_BOB = "tenant-bob-wp";

async function cleanup() {
    await all_async(`DELETE FROM memories`);
    await all_async(`DELETE FROM waypoints`);
}

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

    it("/dynamics/waypoints/calculate-weight validates inputs and returns 400 on invalid payload", async () => {
        let calc_handler: any = null;
        const app_mock = {
            post: (path: string, handler: any) => {
                if (path === "/dynamics/waypoints/calculate-weight") calc_handler = handler;
            },
            get: () => {},
        };
        dynroutes(app_mock);

        expect(calc_handler).toBeTruthy();

        const create_res = () => {
            let status_code = 200;
            let json_body: any = null;
            const res_obj: any = {
                status: function (code: number) {
                    status_code = code;
                    return res_obj;
                },
                set: function (key: string, val: string) {
                    return res_obj;
                },
                setHeader: function (key: string, val: string) {
                    return res_obj;
                },
                json: function (data: any) {
                    json_body = data;
                    return res_obj;
                },
                get_status: () => status_code,
                get_json: () => json_body,
            };
            return res_obj;
        };

        // 1. Empty body
        const res1 = create_res();
        await calc_handler({ tenant: T_ALICE, body: {} }, res1);
        expect(res1.get_status()).toBe(400);

        // 2. Missing target_memory_id
        const res2 = create_res();
        await calc_handler({ tenant: T_ALICE, body: { source_memory_id: "m1" } }, res2);
        expect(res2.get_status()).toBe(400);

        // 3. Oversized memory id (> 256 chars)
        const res3 = create_res();
        await calc_handler(
            { tenant: T_ALICE, body: { source_memory_id: "a".repeat(300), target_memory_id: "m2" } },
            res3,
        );
        expect(res3.get_status()).toBe(400);

        // 4. Tenant mismatch in payload
        const res4 = create_res();
        await calc_handler(
            { tenant: T_ALICE, body: { source_memory_id: "m1", target_memory_id: "m2", user_id: T_BOB } },
            res4,
        );
        expect(res4.get_status()).toBe(403);
    });
});
