process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";

import { describe, it, expect, beforeAll } from "bun:test";
import { run_async } from "../src/core/db";
import { insert_fact } from "../src/temporal_graph/store";
import {
    get_subject_timeline,
    get_predicate_timeline,
    compare_time_points,
    get_volatile_facts,
} from "../src/temporal_graph/timeline";

const T_ALICE = "tenant-alice-timeline-test";
const T_BOB = "tenant-bob-timeline-test";

const SUBJ_ALICE = "AliceSubject_unique_timeline_test";
const SUBJ_BOB = "BobSubject_unique_timeline_test";
const PRED_ROLE = "hasRole_unique_timeline_test";

describe("temporal timeline and volatile facts per-tenant isolation", () => {
    beforeAll(async () => {
        // Clean up any potential leftover rows for these specific test tenants
        await run_async("DELETE FROM temporal_facts WHERE user_id IN (?, ?)", [T_ALICE, T_BOB]);

        // Alice facts
        await insert_fact({
            subject: SUBJ_ALICE,
            predicate: PRED_ROLE,
            object: "Engineer",
            user_id: T_ALICE,
            valid_from: new Date("2026-01-01"),
            confidence: 1.0,
        });

        await insert_fact({
            subject: SUBJ_ALICE,
            predicate: PRED_ROLE,
            object: "Lead Engineer",
            user_id: T_ALICE,
            valid_from: new Date("2026-02-01"),
            confidence: 1.0,
        });

        // Bob facts
        await insert_fact({
            subject: SUBJ_BOB,
            predicate: PRED_ROLE,
            object: "Designer",
            user_id: T_BOB,
            valid_from: new Date("2026-01-01"),
            confidence: 1.0,
        });

        await insert_fact({
            subject: SUBJ_BOB,
            predicate: PRED_ROLE,
            object: "Lead Designer",
            user_id: T_BOB,
            valid_from: new Date("2026-02-01"),
            confidence: 1.0,
        });
    });

    it("get_subject_timeline isolates timeline per tenant", async () => {
        // Query Alice's subject as Alice
        const aliceTimeline = await get_subject_timeline(SUBJ_ALICE, undefined, T_ALICE);
        // Expect 3 entries because the second insert invalidates the first fact
        // (1 created + 1 invalidated + 1 created = 3)
        expect(aliceTimeline.length).toBe(3);
        expect(aliceTimeline.every(entry => entry.subject === SUBJ_ALICE)).toBe(true);

        // Query Bob's subject as Alice (should be empty)
        const bobTimelineAsAlice = await get_subject_timeline(SUBJ_BOB, undefined, T_ALICE);
        expect(bobTimelineAsAlice.length).toBe(0);

        // Query Bob's subject as Bob
        const bobTimelineAsBob = await get_subject_timeline(SUBJ_BOB, undefined, T_BOB);
        expect(bobTimelineAsBob.length).toBe(3);
        expect(bobTimelineAsBob.every(entry => entry.subject === SUBJ_BOB)).toBe(true);
    });

    it("get_predicate_timeline isolates timeline per tenant", async () => {
        const aliceTimeline = await get_predicate_timeline(PRED_ROLE, undefined, undefined, T_ALICE);
        expect(aliceTimeline.length).toBe(3);
        expect(aliceTimeline.every(entry => entry.subject === SUBJ_ALICE)).toBe(true);

        const bobTimeline = await get_predicate_timeline(PRED_ROLE, undefined, undefined, T_BOB);
        expect(bobTimeline.length).toBe(3);
        expect(bobTimeline.every(entry => entry.subject === SUBJ_BOB)).toBe(true);
    });

    it("compare_time_points isolates comparisons per tenant", async () => {
        const t1 = new Date("2026-01-15");
        const t2 = new Date("2026-02-15");

        // Alice comparison for AliceSubject
        const compAlice = await compare_time_points(SUBJ_ALICE, t1, t2, T_ALICE);
        expect(compAlice.changed.length).toBe(1);
        expect(compAlice.changed[0].before.object).toBe("Engineer");
        expect(compAlice.changed[0].after.object).toBe("Lead Engineer");

        // Bob comparison for BobSubject
        const compBob = await compare_time_points(SUBJ_BOB, t1, t2, T_BOB);
        expect(compBob.changed.length).toBe(1);
        expect(compBob.changed[0].before.object).toBe("Designer");
        expect(compBob.changed[0].after.object).toBe("Lead Designer");

        // Alice comparing BobSubject should yield empty results
        const compBobAsAlice = await compare_time_points(SUBJ_BOB, t1, t2, T_ALICE);
        expect(compBobAsAlice.added.length).toBe(0);
        expect(compBobAsAlice.removed.length).toBe(0);
        expect(compBobAsAlice.changed.length).toBe(0);
        expect(compBobAsAlice.unchanged.length).toBe(0);
    });

    it("get_volatile_facts isolates volatile facts per tenant", async () => {
        // Alice volatile facts
        const aliceVolatile = await get_volatile_facts(undefined, 10, T_ALICE);
        expect(aliceVolatile.length).toBe(1);
        expect(aliceVolatile[0].subject).toBe(SUBJ_ALICE);

        // Bob volatile facts
        const bobVolatile = await get_volatile_facts(undefined, 10, T_BOB);
        expect(bobVolatile.length).toBe(1);
        expect(bobVolatile[0].subject).toBe(SUBJ_BOB);
    });
});
