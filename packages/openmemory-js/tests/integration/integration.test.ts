import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { MemoryClient } from "../../src/client";
import { Memory } from "../../src/core/memory";

// Mocking fetch globally to simulate server responses without starting a real HTTP server
// This verifies Client SDK logic + Type compatibility.
// For full Integration, we can also use the Memory class directly which bypasses HTTP but exercises full core logic.

describe("Integration: Client SDK & Core Logic", () => {
    describe("Direct Core Interaction (Memory Class)", () => {
        // This validates the "Server Side" logic that the API endpoints would call
        test("Full Flow: Add -> Search -> Add Fact -> Query", async () => {
            const { waitForDb } = await import("../test_utils");
            await waitForDb();
            const mem = new Memory(); // Core entry point
            const userId = "integration-user-" + Date.now();

            // 1. Add Memory
            const addRes = await mem.add("The project 'Omega' is due on Friday.", { userId, sector: "episodic" });
            expect(addRes.id).toBeDefined();
            expect(addRes.primarySector).toBe("episodic");

            // 2. Search
            const results = await mem.search("Omega project", { userId, limit: 1 });
            // Note: Results might be empty if embeddings are mocked or empty, but the call should succeed.
            expect(Array.isArray(results)).toBe(true);

            // 3. Temporal Fact
            const factId = await mem.temporal.add("Project Omega", "has_deadline", "Friday", { confidence: 0.9 });
            expect(factId).toBeDefined();

            // 4. Temporal History
            const hist = await mem.temporal.history("Project Omega");
            expect(hist.length).toBeGreaterThan(0);
            expect(hist[0].predicate).toBe("has_deadline");
        }, 20000);
    });

    describe("Client SDK Types", () => {
        // This validates that the Client SDK methods align with strict types
        const client = new MemoryClient({ baseUrl: "http://mock-server", token: "test-token" });

        test("addMemory types", async () => {
            // Mock fetch for this test
            const mockFetch = mock(async () => new Response(JSON.stringify({
                id: "mem-123",
                content: "Test",
                primarySector: "semantic",
                userId: "u1"
            })));
            global.fetch = mockFetch as any;

            const res = await client.add("Test content", { userId: "u1" });
            expect(res.id).toBe("mem-123");
            expect(mockFetch).toHaveBeenCalled();
        });
    });
});
