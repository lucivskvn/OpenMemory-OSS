import { expect, test, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { env, reloadConfig } from "../../src/core/cfg";
import * as t_query from "../../src/temporal_graph/query";
import * as t_store from "../../src/temporal_graph/store";
import { closeDb, runAsync } from "../../src/core/db";
import { eventBus, EVENTS } from "../../src/core/events";
import { stopAllMaintenance } from "../../src/core/scheduler";

describe("Temporal Graph Integration Suite", () => {

    beforeAll(async () => {
        // Prepare environment - close any existing DB from previous test files
        await closeDb();
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
    });

    // Ensure strict isolation per test
    beforeEach(async () => {
        // Close existing DB before reconfiguring
        await closeDb();
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
    });

    afterAll(async () => {
        await stopAllMaintenance();
        await closeDb();
    });

    describe("Consistency & Isolation", () => {
        const user1 = "user_alpha";
        const user2 = "user_beta";

        test("Standardized anonymous userId (NULL) storage and retrieval", async () => {
            const subject = "AnonymousEntity";
            const predicate = "hasStatus";
            const object = "active";

            // Insert as anonymous (no userId)
            await t_store.insertFact(subject, predicate, object, new Date(), 1.0, {});

            // Retrieve as anonymous (no userId)
            const fact = await t_query.getCurrentFact(subject, predicate);
            expect(fact).toBeDefined();
            expect(fact?.userId).toBeNull();
            expect(fact?.subject).toBe(subject);

            // Verification of query filter
            const userFact = await t_query.getCurrentFact(subject, predicate, user1);
            expect(userFact).toBeNull();
        });

        test("Multi-tenant isolation for temporal facts", async () => {
            const subject = "SharedSubject";
            const predicate = "commonPredicate";

            await t_store.insertFact(subject, predicate, "Value Alpha", new Date(), 1.0, {}, user1);
            await t_store.insertFact(subject, predicate, "Value Beta", new Date(), 1.0, {}, user2);

            const fact1 = await t_query.getCurrentFact(subject, predicate, user1);
            const fact2 = await t_query.getCurrentFact(subject, predicate, user2);

            expect(fact1?.object).toBe("Value Alpha");
            expect(fact1?.userId).toBe(user1);
            expect(fact2?.object).toBe("Value Beta");
            expect(fact2?.userId).toBe(user2);
        });

        test("Explicit Null User vs Undefined User in Store", async () => {
            const s = "NullSubject";
            const p = "is";
            const o = "NullObject";

            // Pass explicit null
            await t_store.insertFact(s, p, o, new Date(), 1.0, {}, null);

            const f = await t_query.getCurrentFact(s, p, null);
            expect(f).toBeDefined();
            expect(f?.userId).toBeNull();
        });

        test("Cross-User Edge Isolation", async () => {
            const u1 = "u_edge_1";
            const u2 = "u_edge_2";

            // User 1 creates facts
            const f1 = await t_store.insertFact("S1", "P1", "O1", new Date(), 1.0, {}, u1);
            const f2 = await t_store.insertFact("S2", "P2", "O2", new Date(), 1.0, {}, u1);

            // Insert edge:
            await t_store.insertEdge(f1, "related_to", f2, new Date(), 1.0, {}, u1);

            const edges1 = await t_query.queryEdges(f1, undefined, undefined, undefined, u1);
            expect(edges1.length).toBe(1);

            const edges2 = await t_query.queryEdges(f1, undefined, undefined, undefined, u2);
            expect(edges2.length).toBe(0);
        });
    });

    describe("Parity & Advanced Queries", () => {
        test("Temporal Query Range Filtering with NULL user", async () => {
            const s = "TimeSubject";
            const p = "happened_at";

            const oldDate = new Date("2020-01-01");
            await t_store.insertFact(s, p, "Ancient History", oldDate, 1.0, {}, null);

            const newDate = new Date("2025-01-01");
            await t_store.insertFact(s, p, "Recent History", newDate, 1.0, {}, null);

            const range = await t_query.getFactsInRange(
                new Date("2024-01-01"),
                new Date("2026-01-01"),
                null
            );

            expect(range.length).toBe(2); // Overlap logic
            expect(range.some(r => r.object === "Recent History")).toBe(true);
            expect(range.every(r => r.userId === null)).toBe(true);
        });

        test("Batch Fact Insertion", async () => {
            const facts = [
                { id: "bf1", subject: "S_Batch", predicate: "P_Batch", object: "O1", validFrom: new Date(), confidence: 1.0, metadata: {} },
                { id: "bf2", subject: "S_Batch", predicate: "P_Batch", object: "O2", validFrom: new Date(), confidence: 1.0, metadata: {} },
            ];
            const ids = await t_store.batchInsertFacts(facts, "u_batch_user");
            expect(ids.length).toBeGreaterThanOrEqual(2);

            const stored = await t_query.queryFactsAtTime("S_Batch", undefined, undefined, undefined, undefined, "u_batch_user");
            expect(stored.length).toBeGreaterThanOrEqual(1);
        });

        test("Zombie Fact Reproduction (Integrity Check)", async () => {
            const userId = "temp_integrity_" + Date.now();

            // 1. Insert "Future" Fact (T=2000)
            const t2000 = new Date(2000000000000); // Year 2033
            await t_store.insertFact("User", "is_in", "London", t2000, 1.0, {}, userId);

            // 2. Insert "Past" Fact (T=1000) - Year 2001
            const t1000 = new Date(1000000000000);
            await t_store.insertFact("User", "is_in", "Paris", t1000, 1.0, {}, userId);

            // 3. Query at T=2500 (Future of both)
            const t2500 = new Date(2500000000000);
            const facts = await t_query.queryFactsAtTime("User", "is_in", undefined, t2500, 0.0, userId);

            expect(facts.length).toBe(1);
            expect(facts[0].object).toBe("London");
        });
    });

    describe("Event System", () => {
        test("Should emit TEMPORAL_FACT_CREATED on insertion", async () => {
            const subject = "EventTest";
            const predicate = "emits";
            const object = "Created";
            const userId = "user_event_1";

            let capturedEvent: any = null;
            const handler = (payload: any) => { capturedEvent = payload; };

            eventBus.on(EVENTS.TEMPORAL_FACT_CREATED, handler);
            const id = await t_store.insertFact(subject, predicate, object, new Date(), 1.0, { tag: "test" }, userId);
            eventBus.off(EVENTS.TEMPORAL_FACT_CREATED, handler);

            expect(capturedEvent).not.toBeNull();
            expect(capturedEvent.id).toBe(id);
            expect(capturedEvent.userId).toBe(userId);
            expect(capturedEvent.subject).toBe(subject);
            expect(capturedEvent.metadata).toEqual({ tag: "test" });
        });

        test("Should emit TEMPORAL_FACT_UPDATED on update", async () => {
            const subject = "EventTestUpdated";
            const predicate = "emits";
            const object = "Updated";
            const userId = "user_event_2";

            const id = await t_store.insertFact(subject, predicate, object, new Date(), 1.0, {}, userId);

            let capturedEvent: any = null;
            const handler = (payload: any) => { capturedEvent = payload; };

            eventBus.on(EVENTS.TEMPORAL_FACT_UPDATED, handler);
            await t_store.updateFact(id, userId, 0.5, { newTag: "updated" });
            eventBus.off(EVENTS.TEMPORAL_FACT_UPDATED, handler);

            expect(capturedEvent).not.toBeNull();
            expect(capturedEvent.id).toBe(id);
            expect(capturedEvent.userId).toBe(userId);
            expect(capturedEvent.confidence).toBe(0.5);
            expect(capturedEvent.metadata).toEqual({ newTag: "updated" });
        });

        test("Should emit TEMPORAL_FACT_DELETED when invalidated", async () => {
            const subject = "EventTestDeleted";
            const userId = "user_event_3";
            const id = await t_store.insertFact(subject, "willBe", "Deleted", new Date(), 1.0, {}, userId);

            let capturedEvent: any = null;
            const handler = (payload: any) => { capturedEvent = payload; };

            eventBus.on(EVENTS.TEMPORAL_FACT_DELETED, handler);
            await t_store.invalidateFact(id, userId);
            eventBus.off(EVENTS.TEMPORAL_FACT_DELETED, handler);

            expect(capturedEvent).not.toBeNull();
            expect(capturedEvent.id).toBe(id);
            expect(capturedEvent.userId).toBe(userId);
            expect(capturedEvent.validTo).toBeDefined();
        });

        test("Should respect userId isolation in events", async () => {
            const subject = "IsolationTest";
            const userA = "user_A";
            const userB = "user_B";

            let capturedEvent: any = null;
            const handler = (payload: any) => { capturedEvent = payload; };

            eventBus.on(EVENTS.TEMPORAL_FACT_CREATED, handler);

            await t_store.insertFact(subject, "is", "private", new Date(), 1.0, {}, userA);
            expect(capturedEvent.userId).toBe(userA);

            capturedEvent = null; // Reset
            await t_store.insertFact(subject, "is", "private_too", new Date(), 1.0, {}, userB);
            expect(capturedEvent.userId).toBe(userB);
            expect(capturedEvent.userId).not.toBe(userA);

            eventBus.off(EVENTS.TEMPORAL_FACT_CREATED, handler);
        });
    });

    describe("Concurrency & Load", () => {
        const user1 = "user_load";

        test("Transaction safety for temporal operations", async () => {
            const subject = "AtomicSubject";
            const predicate = "atomicPred";

            // Multiple rapid insertions
            const p = [];
            for (let i = 0; i < 10; i++) {
                p.push(t_store.insertFact(subject, predicate, `Val${i}`, new Date(), 1.0, {}, user1));
            }
            await Promise.all(p);

            // Only one should be active for this subject/predicate pair (Cardinality 1 rule)
            const active = await t_query.getFactsBySubject(subject, undefined, false, user1);
            expect(active.length).toBe(1);
        });

        test("Stress Test: High-concurrency temporal insertions", async () => {
            const subject = "StressSubject";
            const predicate = "stressPred";
            const count = 50;

            const tasks = [];
            for (let i = 0; i < count; i++) {
                tasks.push(t_store.insertFact(subject, predicate, `Value${i}`, new Date(), 1.0, {}, user1));
            }
            await Promise.all(tasks);

            const active = await t_query.getFactsBySubject(subject, undefined, false, user1);
            expect(active.length).toBe(1);
        });
    });
});
