import { expect, test, describe, spyOn, beforeEach, beforeAll, afterAll, mock } from "bun:test";
import { addMemory, hsgQuery } from "../src/memory/hsg";
import { classifyContent, getSectorWeights, hydrateMemoryRow } from "../src/memory/utils";
import { sectorConfigs } from "../src/core/hsgConfig";
import { q, vectorStore, transaction, waitForDb, closeDb } from "../src/core/db";
import { Security } from "../src/core/security";
import { Embedder } from "../src/memory/embed";

// Mock implementation of EncryptionProvider
const mockEncryptionProvider = {
    encrypt: mock(async (val: string) => `enc_${val}`),
    decrypt: mock(async (val: string) => val.replace("enc_", "")),
    getKey: mock(async () => ({} as CryptoKey)),
    ALGO: "AES-GCM",
    IV_LEN: 12,
    verifyKey: mock(async () => true)
};

describe("Phase2 Memory Engine", () => {
    // Spies/Mocks
    let qInsMemSpy: any;
    let qGetMemSpy: any;
    let qUpdSeenSpy: any;
    let vecStoreSpy: any;
    let transactionSpy: any;
    let embedMultiSpy: any;
    let embedSectorSpy: any;
    let securitySpy: any;

    beforeAll(async () => {
        // Set test environment
        Bun.env.OM_SKIP_GLOBAL_SETUP = "true";
        
        // Initialize database
        await waitForDb();

        // Mock Security
        securitySpy = spyOn(Security, 'getEncryption').mockReturnValue(mockEncryptionProvider);

        // Mock Embedder
        embedMultiSpy = spyOn(Embedder, 'embedMultiSector').mockResolvedValue([
            { sector: "semantic", vector: [0.1, 0.2], dim: 2 }
        ]);
        embedSectorSpy = spyOn(Embedder, 'embedForSector').mockResolvedValue([0.1, 0.2]);

        // Mock DB functions after q is populated
        qInsMemSpy = spyOn(q.insMem, "run").mockResolvedValue(1);
        qGetMemSpy = spyOn(q.getMemBySimhash, "get").mockResolvedValue(null);
        qUpdSeenSpy = spyOn(q.updSeen, "run").mockResolvedValue(1);

        // Mock Transaction
        transactionSpy = spyOn(transaction, "run").mockImplementation(async (cb: Function) => cb());

        // Mock Vector Store
        vecStoreSpy = spyOn(vectorStore, "storeVector").mockResolvedValue(undefined);
    });

    beforeEach(() => {
        // Clear mock call counts
        qInsMemSpy.mockClear();
        qGetMemSpy.mockClear();
        qUpdSeenSpy.mockClear();
        vecStoreSpy.mockClear();
        transactionSpy.mockClear();
        embedMultiSpy.mockClear();
        embedSectorSpy.mockClear();
        securitySpy.mockClear();

        // Reset default returns
        qGetMemSpy.mockResolvedValue(null);
        embedMultiSpy.mockResolvedValue([
            { sector: "semantic", vector: [0.1, 0.2], dim: 2 }
        ]);
    });

    afterAll(async () => {
        mock.restore();
        await closeDb();
    });

    describe("HSG Content Classification", () => {
        test("should classify episodic content accurately", () => {
            const res = classifyContent("I remember when we went to Japan last year");
            expect(res.primary).toBe("episodic");
        });

        test("should classify procedural content accurately", () => {
            const res = classifyContent("First, install the package. Then, run npm start.");
            expect(res.primary).toBe("procedural");
        });

        test("should fallback to semantic for general content", () => {
            const res = classifyContent("The sky is blue and the grass is green.");
            expect(res.primary).toBe("semantic");
        });

        test("should respect metadata sector override", () => {
            const res = classifyContent("Any content", { sector: "emotional" });
            expect(res.primary).toBe("emotional");
            expect(res.confidence).toBe(1.0);
        });
    });

    describe("Memory Operations", () => {
        test("should add new memory with proper encryption", async () => {
            // Test the actual functionality rather than mocking everything
            const item = await addMemory("This is a semantic fact.", "user-123");

            expect(item.content).toBe("This is a semantic fact.");
            expect(item.primarySector).toBe("semantic");
            expect(item.userId).toBe("user-123");
            expect(item.id).toBeDefined();
            expect(typeof item.id).toBe("string");

            // Verify that encryption was used (mocked)
            expect(securitySpy).toHaveBeenCalled();
        });

        test("should handle duplicate content via simhash deduplication", async () => {
            // Mock the simhash lookup to return existing memory
            const mockGetMemBySimhashSpy = spyOn(q.getMemBySimhash, "get").mockResolvedValue({
                id: "existing-id",
                content: "enc_shared content",
                primarySector: "semantic",
                salience: 0.5,
                userId: "user-123",
                tags: "[]",
                metadata: "{}",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                lastSeenAt: Date.now(),
            });
            
            const mockUpdSeenSpy = spyOn(q.updSeen, "run").mockResolvedValue(1);

            const item = await addMemory("shared content", "user-123");

            expect(item.id).toBe("existing-id");
            expect(mockUpdSeenSpy).toHaveBeenCalled();
            
            // Cleanup
            mockGetMemBySimhashSpy.mockRestore();
            mockUpdSeenSpy.mockRestore();
        });

        test("should handle metadata and tags correctly", async () => {
            const metadata = { source: "test", importance: "high" };
            const tags = ["test", "memory"];
            
            const item = await addMemory("Test content", "user-123", metadata, undefined, tags);

            expect(item.metadata).toEqual({ source: "test", importance: "high" });
            expect(item.tags).toEqual(["test", "memory"]);
            expect(item.content).toBe("Test content");
            expect(item.userId).toBe("user-123");
        });
    });

    describe("Memory Utilities", () => {
        test("should return default weights from configuration", () => {
            const weights = getSectorWeights();
            for (const sector in sectorConfigs) {
                expect(weights[sector]).toBe(sectorConfigs[sector].weight);
            }
        });

        test("should hydrate memory row correctly", () => {
            const mockRow = {
                id: "test-id",
                content: "test content",
                primarySector: "semantic",
                tags: '["tag1", "tag2"]',
                metadata: '{"key": "value"}',
                createdAt: 1000,
                updatedAt: 2000,
                lastSeenAt: 3000,
                salience: 0.8,
                userId: "user-123"
            };

            const hydrated = hydrateMemoryRow(mockRow);

            expect(hydrated.id).toBe("test-id");
            expect(hydrated.content).toBe("test content");
            expect(hydrated.tags).toEqual(["tag1", "tag2"]);
            expect(hydrated.metadata).toEqual({ key: "value" });
            expect(hydrated.salience).toBe(0.8);
        });
    });

    describe("HSG Query System", () => {
        test("should handle query with mocked embeddings", async () => {
            // Mock vector store search
            const mockSearchSpy = spyOn(vectorStore, "searchSimilar").mockResolvedValue([
                { id: "mem-1", score: 0.9 }
            ]);

            // Mock database search
            const mockHsgSearchSpy = spyOn(q.hsgSearch, "all").mockResolvedValue([
                {
                    id: "mem-1",
                    content: "enc_test content",
                    primarySector: "semantic",
                    salience: 0.8,
                    lastSeenAt: Date.now(),
                    createdAt: Date.now(),
                    userId: "user-123"
                }
            ]);

            // Mock vector retrieval
            const mockGetVectorsSpy = spyOn(vectorStore, "getVectorsByIds").mockResolvedValue([
                { id: "mem-1", sector: "semantic", vector: [0.1, 0.2] }
            ]);

            const results = await hsgQuery("test query", 5, { userId: "user-123" });

            expect(results).toBeDefined();
            expect(Array.isArray(results)).toBe(true);
            
            // Cleanup mocks
            mockSearchSpy.mockRestore();
            mockHsgSearchSpy.mockRestore();
            mockGetVectorsSpy.mockRestore();
        });
    });
});