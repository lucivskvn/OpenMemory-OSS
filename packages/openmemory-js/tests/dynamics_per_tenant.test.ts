process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";

import { describe, it, expect, beforeAll } from "bun:test";
import { run_async } from "../src/core/db";
import {
    retrieveMemoriesWithEnergyThresholding,
    buildAssociativeWaypointGraphFromMemories,
    performSpreadingActivationRetrieval,
    propagateAssociativeReinforcementToLinkedNodes,
} from "../src/ops/dynamics";

const T_ALICE = "tenant-alice";
const T_BOB = "tenant-bob";

describe("advanced memory dynamics per-tenant isolation", () => {
    beforeAll(async () => {
        await run_async("DELETE FROM memories");
        await run_async("DELETE FROM waypoints");

        const bufA = Buffer.alloc(16);
        bufA.writeFloatLE(1, 0);
        bufA.writeFloatLE(0, 4);
        bufA.writeFloatLE(0, 8);
        bufA.writeFloatLE(0, 12);

        const bufB = Buffer.alloc(16);
        bufB.writeFloatLE(0, 0);
        bufB.writeFloatLE(1, 4);
        bufB.writeFloatLE(0, 8);
        bufB.writeFloatLE(0, 12);

        // Insert memory for Tenant Alice
        await run_async(
            `INSERT INTO memories (id, user_id, content, primary_sector, salience, mean_dim, mean_vec, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                "mem-alice-1",
                T_ALICE,
                "Alice's preference is dark mode",
                "semantic",
                0.9,
                4,
                bufA,
                Date.now(),
                Date.now(),
            ],
        );
        await run_async(
            `INSERT INTO memories (id, user_id, content, primary_sector, salience, mean_dim, mean_vec, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                "mem-alice-2",
                T_ALICE,
                "Alice likes coffee",
                "semantic",
                0.8,
                4,
                bufA,
                Date.now(),
                Date.now(),
            ],
        );

        // Insert memory for Tenant Bob
        await run_async(
            `INSERT INTO memories (id, user_id, content, primary_sector, salience, mean_dim, mean_vec, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                "mem-bob-1",
                T_BOB,
                "Bob prefers light mode",
                "semantic",
                0.9,
                4,
                bufB,
                Date.now(),
                Date.now(),
            ],
        );

        // Insert waypoints
        await run_async(
            `INSERT INTO waypoints (src_id, dst_id, user_id, weight, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            ["mem-alice-1", "mem-alice-2", T_ALICE, 0.9, Date.now()],
        );
        await run_async(
            `INSERT INTO waypoints (src_id, dst_id, user_id, weight, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            ["mem-bob-1", "mem-bob-2", T_BOB, 0.8, Date.now()],
        );
    });

    it("retrieveMemoriesWithEnergyThresholding only returns the caller's tenant memories", async () => {
        const qv = [1, 0, 0, 0];
        const aliceMems = await retrieveMemoriesWithEnergyThresholding(
            qv,
            "semantic",
            0.1,
            T_ALICE,
        );
        const bobMems = await retrieveMemoriesWithEnergyThresholding(
            qv,
            "semantic",
            0.1,
            T_BOB,
        );

        expect(aliceMems.every((m: any) => m.user_id === T_ALICE)).toBe(true);
        expect(bobMems.every((m: any) => m.user_id === T_BOB)).toBe(true);

        expect(aliceMems.map((m: any) => m.id)).toContain("mem-alice-1");
        expect(aliceMems.map((m: any) => m.id)).not.toContain("mem-bob-1");

        expect(bobMems.map((m: any) => m.id)).toContain("mem-bob-1");
        expect(bobMems.map((m: any) => m.id)).not.toContain("mem-alice-1");
    });

    it("buildAssociativeWaypointGraphFromMemories only returns the caller's tenant waypoints", async () => {
        const aliceGraph =
            await buildAssociativeWaypointGraphFromMemories(T_ALICE);
        const bobGraph = await buildAssociativeWaypointGraphFromMemories(T_BOB);

        expect(aliceGraph.has("mem-alice-1")).toBe(true);
        expect(aliceGraph.has("mem-bob-1")).toBe(false);

        expect(bobGraph.has("mem-bob-1")).toBe(true);
        expect(bobGraph.has("mem-alice-1")).toBe(false);
    });

    it("performSpreadingActivationRetrieval is tenant-isolated", async () => {
        const aliceResults = await performSpreadingActivationRetrieval(
            ["mem-alice-1"],
            3,
            T_ALICE,
        );
        const bobResults = await performSpreadingActivationRetrieval(
            ["mem-bob-1"],
            3,
            T_BOB,
        );

        expect(aliceResults.has("mem-alice-2")).toBe(true);
        expect(aliceResults.has("mem-bob-1")).toBe(false);

        expect(bobResults.has("mem-bob-2")).toBe(true);
        expect(bobResults.has("mem-alice-1")).toBe(false);
    });

    it("propagateAssociativeReinforcementToLinkedNodes only retrieves and updates caller's tenant memories", async () => {
        // Alice propagates on her waypoint
        const wps = [
            { target_id: "mem-alice-2", weight: 0.9 },
            { target_id: "mem-bob-1", weight: 0.8 },
        ];
        const aliceUpdates =
            await propagateAssociativeReinforcementToLinkedNodes(
                "mem-alice-1",
                0.9,
                wps,
                T_ALICE,
            );

        // Should update Alice's memory and ignore/skip Bob's memory
        expect(aliceUpdates.map((u) => u.node_id)).toContain("mem-alice-2");
        expect(aliceUpdates.map((u) => u.node_id)).not.toContain("mem-bob-1");
    });
});
