
import { describe, test, expect, mock, beforeAll } from "bun:test";
import { MemoryClient } from "../src/lib/client";

// Mock fetch globally
const originalFetch = global.fetch;

describe("Dashboard MemoryClient", () => {
    let client: MemoryClient;

    beforeAll(() => {
        client = new MemoryClient({ baseUrl: "http://api.test", token: "test-token" });
    });

    test("should instantiate correctly", () => {
        expect(client).toBeDefined();
    });

    test("getStats should return stats", async () => {
        const mockStats = { system: { uptime: { seconds: 100 } } };
        global.fetch = mock(async () => Response.json(mockStats)) as any;

        const stats = await client.getStats();
        expect(stats).toEqual(mockStats as any);
        expect(fetch).toHaveBeenCalledWith("http://api.test/dashboard/stats", expect.any(Object));
    });

    test("search should return memories", async () => {
        const mockMemories = [{ id: "1", content: "test" }];
        // Client expects { matches: [...] }
        global.fetch = mock(async () => Response.json({ matches: mockMemories })) as any;

        const res = await client.search("query");
        expect(res).toEqual(mockMemories as any);
        expect(fetch).toHaveBeenCalledWith("http://api.test/memory/query", expect.objectContaining({
            method: "POST",
            body: expect.stringContaining("query")
        }));
    });

    test("addFact should call temporal API", async () => {
        const mockRes = { id: "fact-1" };
        global.fetch = mock(async () => Response.json(mockRes)) as any;

        const fact = { subject: "sub", predicate: "rel", object: "obj" };
        const res = await client.addFact(fact);
        expect(res).toEqual(mockRes as any);
        // Client does NOT prepend /api automatically unless it's in baseUrl
        expect(fetch).toHaveBeenCalledWith("http://api.test/temporal/fact", expect.objectContaining({
            method: "POST"
        }));
    });
});
