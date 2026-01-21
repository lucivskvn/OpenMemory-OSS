import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { cleanupOrphanedVectors, verifyVectorConsistency } from "../../src/ops/vector_maint";
import { extractURL } from "../../src/ops/extract";
import { vectorStore, q } from "../../src/core/db";

// Mock validateUrl to avoid network/security complications in test
mock.module("../../src/utils/security", () => ({
    validateUrl: mock(async (u) => ({ url: u, originalUrl: u })),
}));

// Mock DB and Vector Store
mock.module("../../src/core/db", () => ({
    q: {
        getMems: { all: mock(async () => []) },
        allMemIds: { all: mock(async () => []) },
        insMem: { run: mock(async () => { }) }, // Added to satisfy waitForDb check
    },
    waitForDb: mock(async () => true), // Bypass waitForDb
    closeDb: mock(async () => true), // Mock closeDb to avoid errors in setup/teardown
    vectorStore: {
        getAllVectorIds: mock(async () => new Set()),
        iterateVectorIds: async function* () { yield* []; },
        deleteVectors: mock(async () => { }),
        getVectorsByIds: mock(async () => []),
    }
}));

describe("Verification: Vector Maintenance", () => {
    beforeEach(() => {
        // Reset mocks
        mock.restore();
    });

    test("cleanupOrphanedVectors uses streaming iterator", async () => {
        const mockIds = ["vec1", "vec2", "vec3", "vec4", "vec5"];
        const batchSize = 2; // We can't change the internal batch size easily without exporting it, but we can verify it processes everything.

        // Mock iterateVectorIds to yield our mock IDs
        vectorStore.iterateVectorIds = async function* () {
            for (const id of mockIds) yield id;
        };

        // Mock q.getMems.all to return only some memories (vec2, vec4 exist)
        q.getMems.all = mock(async (ids: string[]) => {
            return ids
                .filter(id => ["vec2", "vec4"].includes(id))
                .map(id => ({ id }));
        });

        const deleteSpy = mock(async () => { });
        vectorStore.deleteVectors = deleteSpy;

        const result = await cleanupOrphanedVectors("user1");

        // Should have scanned 5
        expect(result.scanned).toBe(5);
        // Should have deleted 3 (vec1, vec3, vec5)
        expect(result.deleted).toBe(3);

        // deleteVectors should have been called at least once
        expect(deleteSpy).toHaveBeenCalled();
    });

    test("verifyVectorConsistency handles missing vectors", async () => {
        // Mock q.allMemIds to return 3 memories
        q.allMemIds.all = mock(async (limit, offset) => {
            if (offset === 0) return [{ id: "mem1" }, { id: "mem2" }, { id: "mem3" }];
            return [];
        });

        // Mock vectorStore.getVectorsByIds to return only mem1
        // (mem2 and mem3 missing vectors)
        vectorStore.getVectorsByIds = mock(async (ids: string[]) => {
            return ids.filter(id => id === "mem1").map(id => ({ id, sector: "test", vector: [], dim: 10 }));
        });

        vectorStore.iterateVectorIds = async function* () { yield* []; }; // No orphans

        const result = await verifyVectorConsistency("user1");

        expect(result.totalMemories).toBe(3);
        expect(result.missingVectorCount).toBe(2);
    });
});

describe("Verification: Extraction", () => {
    test("extractURL uses configured User-Agent", async () => {
        const customAgent = "CustomBot/1.0";
        const targetUrl = "http://example.com";

        // Mock fetch
        const originalFetch = global.fetch;
        let capturedHeaders: Headers | undefined;

        // Cast to any to bypass strict type check for now
        global.fetch = mock(async (url: any, init: any) => {
            const u = url.toString();
            if (u === targetUrl || u === targetUrl + "/") {
                capturedHeaders = new Headers(init?.headers);
                return new Response("<html><body>Content</body></html>", { headers: { "Content-Type": "text/html" } });
            }
            return new Response("Not Found", { status: 404 });
        }) as any;

        try {
            await extractURL(targetUrl, { userAgent: customAgent });

            expect(capturedHeaders).toBeDefined();
            expect(capturedHeaders?.get("User-Agent")).toBe(customAgent);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
