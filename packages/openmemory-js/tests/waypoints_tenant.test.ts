process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_EMBEDDING_FALLBACK = "synthetic";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";

import { beforeEach, describe, expect, it } from "bun:test";
import { all_async, q } from "../src/core/db";

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
        expect(all_wps_before.length).toBe(2);

        // Delete waypoints for Alice only
        await q.del_waypoints.run(mem_id, mem_id, T_ALICE);

        // Verify Bob's waypoint still exists
        const wps = await all_async(`SELECT * FROM waypoints`);
        expect(wps.length).toBe(1);
        expect(wps[0].user_id).toBe(T_BOB);
        expect(wps[0].dst_id).toBe("dst-bob");
    });
});
