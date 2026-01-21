
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { q } from "../../src/core/db";
import { runAsync, allAsync } from "../../src/core/db_access";
import { normalizeUserId } from "../../src/utils";

describe("Core Security & Isolation", () => {
    const userA = "sec-user-a";
    const userB = "sec-user-b";
    let memAId: string;

    test("CONFIRM VULNERABILITY: Anonymous Memory instance SHOULD NOT access User A's private memory", async () => {
        // Setup inside test to ensure persistence
        const memA = new Memory(userA);
        const res = await memA.add("Secret plan for User A", { tags: ["secret"] });
        memAId = res.id;

        // Verify it exists basically
        const rows = await allAsync("SELECT * FROM memories WHERE id = ?", [memAId]);
        expect(rows.length).toBe(1);

        const anonMem = new Memory(); // No userId provided
        const item = await anonMem.get(memAId);

        if (item) {
            console.error("VULNERABILITY CONFIRMED: Anonymous user accessed private memory:", item.id);
        } else {
            console.log("SECURE: Anonymous user could not access private memory");
        }

        expect(item).toBeUndefined();
    });

    test("Anonymous Memory.update should NOT update User A's private memory", async () => {
        const memA = new Memory(userA);
        // Create a new memory specifically for this test
        const res = await memA.add("Secret Update Target", { tags: ["secret"] });

        const anonMem = new Memory();
        try {
            const updateRes = await anonMem.update(res.id, "HACKED CONTENT");

            // If it succeeds, it returns { id, success: true }
            if (updateRes.success) {
                console.error("VULNERABILITY CONFIRMED: Anonymous user UPDATED private memory:", res.id);
            }
            expect(updateRes.success).toBeFalse();
        } catch (e) {
            // If it throws "Memory not found" or similar, that is also a pass
            expect(true).toBeTrue();
        }

        // Double check content
        const fresh = await memA.get(res.id);
        expect(fresh?.content).toBe("Secret Update Target");
    });

    test("User B should NOT access User A's private memory", async () => {
        const memA = new Memory(userA);
        const res = await memA.add("Secret A2", { tags: ["secret"] });

        const memB = new Memory(userB);
        const item = await memB.get(res.id);
        expect(item).toBeUndefined();
    });

    test("Anonymous Memory.add should store with NULL userId", async () => {
        const anonMem = new Memory();
        const res = await anonMem.add("Public anonymous note");

        // Verify in DB directly
        const rows = await allAsync("SELECT * FROM memories WHERE id = ?", [res.id]) as any[];
        expect(rows.length).toBe(1);
        expect(rows[0].userId).toBeNull();
    });

    test("Memory.search with Anonymous user should NOT return User A's memory", async () => {
        const anonMem = new Memory();
        const results = await anonMem.search("Secret plan");

        const found = results.some(r => r.id === memAId);
        expect(found).toBeFalse();
    });
});
