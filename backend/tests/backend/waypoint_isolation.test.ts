import { describe, expect, it, beforeAll } from "bun:test";
import { q } from "../../src/core/db";

describe("Waypoint multi-tenant isolation", () => {
    const userA = "wp_user_a_" + Date.now();
    const userB = "wp_user_b_" + Date.now();

    let a1: string, a2: string, b1: string;

    it("should insert memories and waypoints and respect user isolation", async () => {
        // Ensure a clean DB state for test determinism
        const { resetDb } = await import("../helpers/reset_db");
        await resetDb();
        a1 = "a1_" + Date.now();
        a2 = "a2_" + Date.now();
        b1 = "b1_" + Date.now();

        // Insert memories
        // Provide 18 fields matching the table definition (mean_dim included as null)
        console.log('[TST] inserting mem a1', a1, userA);
        await q.ins_mem.run(a1, userA, 0, "A1", null, "semantic", null, null, Date.now(), Date.now(), Date.now(), 0.5, 0.0, 1, null, null, null, 0);
        console.log('[TST] inserted mem a1');
        console.log('[TST] inserting mem a2', a2, userA);
        await q.ins_mem.run(a2, userA, 0, "A2", null, "semantic", null, null, Date.now(), Date.now(), Date.now(), 0.5, 0.0, 1, null, null, null, 0);
        console.log('[TST] inserted mem a2');
        console.log('[TST] inserting mem b1', b1, userB);
        await q.ins_mem.run(b1, userB, 0, "B1", null, "semantic", null, null, Date.now(), Date.now(), Date.now(), 0.5, 0.0, 1, null, null, null, 0);
        console.log('[TST] inserted mem b1');

        // Insert waypoints within same tenant
        console.log('[TST] inserting waypoint a1->a2');
        await q.ins_waypoint.run(a1, a2, userA, 0.8, Date.now(), Date.now());
        console.log('[TST] inserted waypoint a1->a2');
        // Insert a cross-tenant waypoint from a1 to b1 (belongs to userB)
        console.log('[TST] inserting waypoint a1->b1 (userB)');
        await q.ins_waypoint.run(a1, b1, userB, 0.9, Date.now(), Date.now());
        console.log('[TST] inserted waypoint a1->b1');

        // Fetch neighbors for a1 scoped to userA
        const neighA = await q.get_neighbors.all(a1, userA);
        expect(neighA.some(n => n.dst_id === a2)).toBeTrue();
        expect(neighA.some(n => n.dst_id === b1)).toBeFalse();

        // Fetch neighbors for a1 scoped to userB (should show b1)
        const neighB = await q.get_neighbors.all(a1, userB);
        expect(neighB.some(n => n.dst_id === b1)).toBeTrue();
        expect(neighB.some(n => n.dst_id === a2)).toBeFalse();
    });
});