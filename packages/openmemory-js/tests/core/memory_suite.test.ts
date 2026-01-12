import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { q, closeDb, runAsync, transaction } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";

describe("Core Memory & DX Suite", () => {
    let mem: Memory;

    beforeAll(async () => {
        // Force SQLite backend for tests to avoid Redis dependency if possible, or support ValKey
        process.env.OM_VECTOR_BACKEND = "sqlite";
        const { reloadConfig, env } = await import("../../src/core/cfg");
        reloadConfig();

        mem = new Memory(); // user-less initial instance, or use static methods if any

        // Clear DB for isolation (Scoped to this suite)
        const targetUsers = "'userA', 'userB', 'tx_user', 'dx_test_user', 'user1'";
        await runAsync(`DELETE FROM memories WHERE user_id IN (${targetUsers}) OR user_id IS NULL`);
        await runAsync(`DELETE FROM users WHERE user_id IN (${targetUsers})`);
        await runAsync(`DELETE FROM temporal_facts WHERE user_id IN (${targetUsers}) OR user_id IS NULL`);
        await runAsync(`DELETE FROM temporal_edges WHERE user_id IN (${targetUsers}) OR user_id IS NULL`);

        // Flush ValKey if enabled (similar to core.test.ts logic)
        if (env.vectorBackend === "valkey") {
            try {
                const Redis = (await import("ioredis")).default;
                const redis = new Redis({
                    host: env.valkeyHost || "localhost",
                    port: env.valkeyPort || 6379,
                    password: env.valkeyPassword,
                    lazyConnect: true,
                    retryStrategy: () => null
                });
                redis.on("error", () => { });
                await redis.connect();
                await redis.flushdb();
                await redis.quit();
            } catch (e) { /* ignore */ }
        }
    });

    afterAll(async () => {
        await stopAllMaintenance();
        await closeDb();
    });

    describe("Basic Memory Operations", () => {
        test("Anonymous User (userId: null) Handling", async () => {
            // Insert as anonymous
            const res = await mem.add("I am anonymous", { userId: undefined });
            expect(res.id).toBeDefined();

            // Retrieve directly from DB to verify null storage
            const row = await q.getMem.get(res.id, null as any);
            expect(row).toBeDefined();
            expect(row?.userId).toBeNull();

            // Search as anonymous
            const hits = await mem.search("anonymous", { userId: null as any });
            expect(hits.length).toBeGreaterThan(0);
            expect(hits[0].id).toBe(res.id);

            // Verify isolation: Specific user should NOT see this
            const userHits = await mem.search("anonymous", { userId: "user1" });
            expect(userHits.length).toBe(0);
        });

        test("Memory.add & get (Scoped user)", async () => {
            const user = "dx_test_user";
            const userMem = new Memory(user);

            const res = await userMem.add("Hello World");
            expect(res.id).toBeDefined();

            const fetched = await userMem.get(res.id);
            expect(fetched).toBeDefined();
            expect(fetched?.content).toBe("Hello World");
            expect(fetched?.userId).toBe(user);

            // Test Cross-User Access
            const otherMem = new Memory("other_user");
            const stolen = await otherMem.get(res.id);
            expect(stolen).toBeFalsy(); // Should not be seen
        });

        test("Memory.deleteAll (Safety)", async () => {
            const user = "dx_test_user";
            const userMem = new Memory(user);
            await userMem.add("To be deleted");
            await userMem.deleteAll();

            // Should be empty
            const search = await userMem.search("deleted");
            expect(search.length).toBe(0);
        });
    });

    describe("Temporal Graph Interfaces", () => {
        test("Memory.temporal proxies correctly", async () => {
            const user = "dx_test_user";
            const userMem = new Memory(user);
            await userMem.temporal.add("Alice", "knows", "Bob");

            const fact = await userMem.temporal.get("Alice", "knows");
            expect(fact).toBeDefined();
            expect(fact?.object).toBe("Bob");

            // Verify it is user-scoped
            const otherMem = new Memory("other_user");
            const stolenFact = await otherMem.temporal.get("Alice", "knows");
            expect(stolenFact).toBeNull();
        });
    });

    describe("Transactions & Isolation", () => {
        test("Nested Transaction Rollback Verification", async () => {
            const userId = "tx_user";

            // Initial state
            await mem.add("Pre-transaction", { userId });
            const initialCount = (await q.getMemCount.get(userId))?.c || 0;
            expect(initialCount).toBe(1);

            // Attempt nested transaction with failure
            try {
                await transaction.run(async () => {
                    await mem.add("Pending Commit 1", { userId });
                    await mem.add("Pending Commit 2", { userId });
                    throw new Error("Simulated Rollback");
                });
            } catch (e: any) {
                expect(e.message).toBe("Simulated Rollback");
            }

            // Verify rollback: Count should match initial
            const finalCount = (await q.getMemCount.get(userId))?.c || 0;
            expect(finalCount).toBe(initialCount);
        });

        test("VectorStore User Isolation", async () => {
            const userA = "userA";
            const userB = "userB";

            await mem.add("Common Topic", { userId: userA });
            await mem.add("Common Topic", { userId: userB });

            // Search User A
            const hitsA = await mem.search("Topic", { userId: userA });
            expect(hitsA.length).toBeGreaterThan(0);

            await mem.add("Unique A", { userId: userA });
            await mem.add("Unique B", { userId: userB });

            const searchA = await mem.search("Unique", { userId: userA });
            // Relaxed check: Ensure it found "Unique A" and strictly did NOT find "Unique B"
            const foundA = searchA.some(h => h.content === "Unique A");
            const foundB_in_A = searchA.some(h => h.content === "Unique B");

            expect(foundA).toBe(true);
            expect(foundB_in_A).toBe(false);

            const searchB = await mem.search("Unique", { userId: userB });
            const foundB = searchB.some(h => h.content === "Unique B");
            const foundA_in_B = searchB.some(h => h.content === "Unique A");

            expect(foundB).toBe(true);
            expect(foundA_in_B).toBe(false);
        });
    });
});
