import { expect, test, describe, spyOn, beforeEach, beforeAll, afterAll, mock } from "bun:test";
import { addMemory } from "../src/memory/hsg";
import { classifyContent, getSectorWeights } from "../src/memory/utils";
import { sectorConfigs } from "../src/core/hsg_config";
import { q, vectorStore, transaction } from "../src/core/db";
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

describe("HSG Unit Tests", () => {
    // Spies/Mocks
    let qInsMemSpy: any;
    let qGetMemSpy: any;
    let qUpdSeenSpy: any;
    let vecStoreSpy: any;
    let transactionSpy: any;
    let embedMultiSpy: any;
    let embedSectorSpy: any;
    let securitySpy: any;

    beforeAll(() => {
        // Mock Security
        // Use spyOn to intercept calls to getEncryption
        securitySpy = spyOn(Security, 'getEncryption').mockReturnValue(mockEncryptionProvider);

        // Mock Embedder
        embedMultiSpy = spyOn(Embedder, 'embedMultiSector').mockResolvedValue([
            { sector: "semantic", vector: [0.1, 0.2], dim: 2 }
        ]);
        embedSectorSpy = spyOn(Embedder, 'embedForSector').mockResolvedValue([0.1, 0.2]);

        // Mock DB Mocks
        // Since q properties might be lazily loaded, we ensure they exist as mocks
        if (!(q as any).insMem) (q as any).insMem = { run: mock(async () => { }) };
        if (!(q as any).getMemBySimhash) (q as any).getMemBySimhash = { get: mock(async () => null) };
        if (!(q as any).updSeen) (q as any).updSeen = { run: mock(async () => { }) };

        // Spy on them
        qInsMemSpy = spyOn(q.insMem, "run");
        qGetMemSpy = spyOn(q.getMemBySimhash, "get");
        qUpdSeenSpy = spyOn(q.updSeen, "run");

        // Mock Transaction
        transactionSpy = spyOn(transaction, "run").mockImplementation(async (cb: Function) => cb());

        // Mock Vector Store
        if (!(vectorStore as any).storeVector) (vectorStore as any).storeVector = mock(async () => { });
        vecStoreSpy = spyOn(vectorStore, "storeVector");
    });

    beforeEach(() => {
        // Clear counts
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

    afterAll(() => {
        mock.restore();
    });

    describe("classifyContent", () => {
        test("should identify episodic content", () => {
            const res = classifyContent("I remember when we went to Japan last year");
            expect(res.primary).toBe("episodic");
        });

        test("should identify procedural content", () => {
            const res = classifyContent("First, install the package. Then, run npm start.");
            expect(res.primary).toBe("procedural");
        });

        test("should fallback to semantic for general content", () => {
            const res = classifyContent("The sky is blue and the grass is green.");
            expect(res.primary).toBe("semantic");
        });
    });

    describe("addMemory", () => {
        test("should add a new memory with basic content", async () => {
            const item = await addMemory("This is a semantic fact.", "user-123");

            expect(item.content).toBe("This is a semantic fact.");
            expect(item.primarySector).toBe("semantic");
            expect(item.userId).toBe("user-123");

            expect(q.insMem.run).toHaveBeenCalled();
            expect(vectorStore.storeVector).toHaveBeenCalled();
            // Check that encryption was accessed
            expect(Security.getEncryption).toHaveBeenCalled();
        });

        test("should handle duplicate content via simhash", async () => {
            // Setup duplicate found scenario
            qGetMemSpy.mockResolvedValue({
                id: "existing-id",
                content: "enc_shared content",
                primarySector: "semantic",
                salience: 0.5,
                userId: "user-123",
            });

            const item = await addMemory("shared content", "user-123");

            expect(item.id).toBe("existing-id");
            expect(q.updSeen.run).toHaveBeenCalled();
            // Should NOT insert new memory
            expect(q.insMem.run).not.toHaveBeenCalled();
            // Should NOT store new vector
            expect(vectorStore.storeVector).toHaveBeenCalledTimes(0);
        });
    });

    describe("getSectorWeights", () => {
        test("should return default weights from config", () => {
            const weights = getSectorWeights();
            for (const sector in sectorConfigs) {
                expect(weights[sector]).toBe(sectorConfigs[sector].weight);
            }
        });
    });
});
