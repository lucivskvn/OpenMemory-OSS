import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Memory } from "../src/core/memory";
import { run_async, close_db } from "../src/core/db";
import { stop_hsg_maintenance } from "../src/memory/hsg";

// Mock environment for DX test
const TEST_USER = "dx_test_user";

describe("Client DX & Multi-Tenancy", () => {
    console.log("[TEST] Client DX Suite Starting...");
    const mem = new Memory(TEST_USER);

    beforeAll(async () => {
        console.log("[TEST] beforeAll: cleaning up...");
        // Ensure clean state
        await mem.delete_all();
        console.log("[TEST] beforeAll: cleanup done");
    });

    afterAll(async () => {
        await mem.delete_all();
        stop_hsg_maintenance();
    });

    test("Memory.add & get (Scoped)", async () => {
        const res = await mem.add("Hello World");
        expect(res.id).toBeDefined();

        const fetched = await mem.get(res.id);
        expect(fetched).toBeDefined();
        expect(fetched?.content).toBe("Hello World");
        expect(fetched?.user_id).toBe(TEST_USER);

        // Test Cross-User Access
        const otherMem = new Memory("other_user");
        const stolen = await otherMem.get(res.id);
        expect(stolen).toBeFalsy(); // Should not be able to see it
    });

    test("Memory.temporal (Graph)", async () => {
        await mem.temporal.add("Alice", "knows", "Bob");

        const fact = await mem.temporal.get("Alice", "knows");
        expect(fact).toBeDefined();
        expect(fact?.object).toBe("Bob");

        // Verify it is user-scoped
        const otherMem = new Memory("other_user");
        const stolenFact = await otherMem.temporal.get("Alice", "knows");
        expect(stolenFact).toBeNull();
    });

    test("Memory.delete_all (Safety)", async () => {
        await mem.add("To be deleted");
        await mem.delete_all();

        // Should be empty
        const search = await mem.search("deleted");
        expect(search.length).toBe(0);
    });
});
