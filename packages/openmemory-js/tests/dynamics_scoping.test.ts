process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";

import { describe, it, expect, beforeAll } from "bun:test";
import { run_async, q } from "../src/core/db";
import {
    buildAssociativeWaypointGraphFromMemories,
    performSpreadingActivationRetrieval,
    retrieveMemoriesWithEnergyThresholding,
    propagateAssociativeReinforcementToLinkedNodes,
} from "../src/ops/dynamics";
import { vectorToBuffer } from "../src/memory/embed";

const T_ALICE = "tenant-alice";
const T_BOB = "tenant-bob";

describe("dynamics per-tenant isolation", () => {
    beforeAll(async () => {
        await run_async("DELETE FROM memories");
        await run_async("DELETE FROM waypoints");

        // Insert memories for Alice
        await q.ins_mem.run(
            "mem-alice-1",
            T_ALICE,
            "project-1",
            0,
            "Alice secret context 1",
            "sh-a-1",
            "semantic",
            "[]",
            "{}",
            Date.now(),
            Date.now(),
            Date.now(),
            0.8, // salience
            0.02, // decay_lambda
            1,
            3,
            vectorToBuffer([0.1, 0.2, 0.3]),
            null,
            0
        );

        await q.ins_mem.run(
            "mem-alice-2",
            T_ALICE,
            "project-1",
            0,
            "Alice secret context 2",
            "sh-a-2",
            "semantic",
            "[]",
            "{}",
            Date.now(),
            Date.now(),
            Date.now(),
            0.7, // salience
            0.02, // decay_lambda
            1,
            3,
            vectorToBuffer([0.15, 0.25, 0.35]),
            null,
            0
        );

        // Insert memories for Bob
        await q.ins_mem.run(
            "mem-bob-1",
            T_BOB,
            "project-1",
            0,
            "Bob secret context 1",
            "sh-b-1",
            "semantic",
            "[]",
            "{}",
            Date.now(),
            Date.now(),
            Date.now(),
            0.9, // salience
            0.02, // decay_lambda
            1,
            3,
            vectorToBuffer([0.5, 0.6, 0.7]),
            null,
            0
        );

        await q.ins_mem.run(
            "mem-bob-2",
            T_BOB,
            "project-1",
            0,
            "Bob secret context 2",
            "sh-b-2",
            "semantic",
            "[]",
            "{}",
            Date.now(),
            Date.now(),
            Date.now(),
            0.8, // salience
            0.02, // decay_lambda
            1,
            3,
            vectorToBuffer([0.55, 0.65, 0.75]),
            null,
            0
        );

        // Insert waypoints
        await q.ins_waypoint.run(
            "mem-alice-1",
            "mem-alice-2",
            T_ALICE,
            "project-1",
            0.95, // weight
            Date.now(),
            Date.now()
        );

        // Valid Bob waypoint
        await q.ins_waypoint.run(
            "mem-bob-1",
            "mem-bob-2",
            T_BOB,
            "project-1",
            0.85, // weight
            Date.now(),
            Date.now()
        );

        // Invalid Bob cross-tenant waypoint
        await q.ins_waypoint.run(
            "mem-bob-1",
            "mem-alice-2", // pointing across tenant? (cross-tenant waypoint simulation)
            T_BOB,
            "project-1",
            0.8, // weight
            Date.now(),
            Date.now()
        );
    });

    it("buildAssociativeWaypointGraphFromMemories only returns waypoints owned by the specified tenant", async () => {
        const aliceGraph = await buildAssociativeWaypointGraphFromMemories(T_ALICE);
        const bobGraph = await buildAssociativeWaypointGraphFromMemories(T_BOB);

        expect(aliceGraph.has("mem-alice-1")).toBe(true);
        expect(aliceGraph.has("mem-bob-1")).toBe(false);

        expect(bobGraph.has("mem-bob-1")).toBe(true);
        expect(bobGraph.has("mem-bob-2")).toBe(true);
        expect(bobGraph.has("mem-alice-1")).toBe(false);
    });

    it("performSpreadingActivationRetrieval isolates activation flow to tenant scope", async () => {
        const aliceAct = await performSpreadingActivationRetrieval(["mem-alice-1"], 3, T_ALICE);
        const bobAct = await performSpreadingActivationRetrieval(["mem-bob-1"], 3, T_BOB);

        // Alice cannot spread activation to Bob's nodes
        expect(aliceAct.has("mem-bob-1")).toBe(false);
        // Bob cannot spread activation to Alice's nodes despite the link to mem-alice-2
        expect(bobAct.has("mem-alice-2")).toBe(false);
    });

    it("retrieveMemoriesWithEnergyThresholding only retrieves memories for the correct tenant", async () => {
        const queryVector = [0.1, 0.2, 0.3];
        const aliceMems = await retrieveMemoriesWithEnergyThresholding(queryVector, "semantic", 0.1, T_ALICE);
        const bobMems = await retrieveMemoriesWithEnergyThresholding(queryVector, "semantic", 0.1, T_BOB);

        expect(aliceMems.every((m: any) => m.id.startsWith("mem-alice-"))).toBe(true);
        expect(bobMems.every((m: any) => m.id.startsWith("mem-bob-"))).toBe(true);
    });

    it("propagateAssociativeReinforcementToLinkedNodes rejects propagating across tenants", async () => {
        // Simulating a rogue node trying to reinforce cross-tenant
        const wps = [{ target_id: "mem-alice-2", weight: 0.9 }];
        const propagated = await propagateAssociativeReinforcementToLinkedNodes("mem-bob-1", 0.8, wps, T_BOB);

        // Propagated updates should be empty because mem-alice-2 is not in Bob's tenant memories
        expect(propagated.length).toBe(0);
    });
});
