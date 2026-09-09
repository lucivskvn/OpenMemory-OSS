process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_EMBEDDING_FALLBACK = "synthetic";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";

import { beforeEach, describe, expect, it } from "bun:test";
import { all_async, q } from "../src/core/db";
import { expand_via_waypoints } from "../src/memory/hsg";

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

    it("q.get_neighbors and expand_via_waypoints isolate graph traversal by user_id", async () => {
        const mem_id = "node-1";
        const now = Date.now();

        // Insert waypoints for Alice and Bob starting from the same src_id
        await q.ins_waypoint.run(mem_id, "dst-alice", T_ALICE, null, 0.8, now, now);
        await q.ins_waypoint.run(mem_id, "dst-bob", T_BOB, null, 0.9, now, now);

        // q.get_neighbors filtered by Alice should only return Alice's waypoint
        const alice_neighs = await q.get_neighbors.all(mem_id, T_ALICE);
        expect(alice_neighs).toHaveLength(1);
        expect(alice_neighs[0].dst_id).toBe("dst-alice");

        // expand_via_waypoints filtered by Alice should not traverse Bob's waypoint
        const exp = await expand_via_waypoints([mem_id], 10, T_ALICE);
        const ids = exp.map((e) => e.id);
        expect(ids).toContain("node-1");
        expect(ids).toContain("dst-alice");
        expect(ids).not.toContain("dst-bob");
    });

    it("fails closed when user_id is missing, empty, or wrong tenant", async () => {
        const mem_id = "node-2";
        const now = Date.now();

        await q.ins_waypoint.run(mem_id, "dst-alice", T_ALICE, null, 0.8, now, now);

        // Missing/undefined user_id fails closed (returns empty)
        expect(await q.get_neighbors.all(mem_id, undefined as any)).toEqual([]);
        expect(await expand_via_waypoints([mem_id], 10, undefined)).toEqual([]);

        // Empty string fails closed
        expect(await q.get_neighbors.all(mem_id, "")).toEqual([]);
        expect(await expand_via_waypoints([mem_id], 10, "")).toEqual([]);

        // Whitespace-only string fails closed
        expect(await q.get_neighbors.all(mem_id, "   ")).toEqual([]);
        expect(await expand_via_waypoints([mem_id], 10, "   ")).toEqual([]);

        // Non-matching/wrong tenant returns no expanded neighbor waypoints
        expect(await q.get_neighbors.all(mem_id, T_BOB)).toEqual([]);
        const bob_exp = await expand_via_waypoints([mem_id], 10, T_BOB);
        expect(bob_exp.map((e) => e.id)).not.toContain("dst-alice");
    });
});
