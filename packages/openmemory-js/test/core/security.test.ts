
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { Memory } from "../../src/core/memory";
import { q } from "../../src/core/db";
import { runAsync, allAsync } from "../../src/core/db_access";
import { normalizeUserId } from "../../src/utils";

// Mock the embedding system to prevent model loading in tests
mock.module("../../src/memory/embed", () => ({
    Embedder: {
        embedMultiSector: mock(async (id: string, content: string, sectors: string[]) => {
            return sectors.map(sector => ({
                sector,
                vector: new Array(384).fill(0).map(() => Math.random()),
                dim: 384
            }));
        }),
        embedForSector: mock(async (content: string, sector: string) => {
            return new Array(384).fill(0).map(() => Math.random());
        }),
        embedQueryForAllSectors: mock(async (query: string, sectors: string[]) => {
            return sectors.map(sector => ({
                sector,
                vector: new Array(384).fill(0).map(() => Math.random()),
                dim: 384
            }));
        })
    }
}));

describe("Phase1 Core Security & Isolation", () => {
    const userA = "sec-user-a";
    const userB = "sec-user-b";
    let memAId: string;

    beforeAll(async () => {
        // Set test environment
        Bun.env.OM_SKIP_GLOBAL_SETUP = "true";
        Bun.env.OM_DB_PATH = ":memory:";
        Bun.env.OM_TEST_MODE = "true";
        Bun.env.OM_LOG_LEVEL = "error";
        Bun.env.OM_KEEP_DB = "true"; // Keep the same DB connection across tests
        
        // Initialize database once
        const { waitForDb } = await import("../../src/core/db");
        await waitForDb();
    });

    afterAll(async () => {
        const { closeDb } = await import("../../src/core/db");
        await closeDb();
    });

    test("CONFIRM VULNERABILITY: Anonymous Memory instance SHOULD NOT access User A's private memory", async () => {
        // Setup inside test to ensure persistence
        const memA = new Memory(userA);
        
        try {
            const res = await memA.add("Secret plan for User A", { tags: ["secret"] });
            memAId = res.id;
            console.log("Memory added successfully:", res.id);

            // Verify it exists using the same q object that Memory uses
            const rows = await q.getMems.all([memAId]);
            console.log("Database rows found:", rows.length);
            if (rows.length === 0) {
                console.log("No rows found, checking all memories:");
                const allRows = await q.allMem.all(100, 0);
                console.log("All memories:", allRows.length);
            }
            expect(rows.length).toBe(1);
        } catch (error) {
            console.error("Error adding memory:", error);
            throw error;
        }

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

        // Verify in DB using q object
        const rows = await q.getMems.all([res.id]);
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
