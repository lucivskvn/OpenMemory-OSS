import { describe, expect, it, beforeEach, spyOn, mock } from "bun:test";
import { WebhookRepository } from "../../src/core/repository/webhook";
import { RateLimitRepository } from "../../src/core/repository/rateLimit";
import { MemoryRepository } from "../../src/core/repository/memory";
import { TABLES } from "../../src/core/db_access";

describe("Repository Fixes Verification", () => {
    let mockDb: any;
    let webhookRepo: WebhookRepository;
    let rateLimitRepo: RateLimitRepository;
    let memoryRepo: MemoryRepository;

    beforeEach(() => {
        mockDb = {
            runAsync: mock(async () => 1),
            getAsync: mock(async () => ({})),
            allAsync: mock(async () => []),
            runUser: mock(async () => 1),
            getUser: mock(async () => ({})),
            allUser: mock(async () => []),
            transaction: { run: mock((fn: any) => fn()) },
        };

        webhookRepo = new WebhookRepository(mockDb);
        rateLimitRepo = new RateLimitRepository(mockDb);
        memoryRepo = new MemoryRepository(mockDb);
    });

    it("WebhookRepository.list should use allAsync when no userId provided", async () => {
        await webhookRepo.list();
        expect(mockDb.allAsync).toHaveBeenCalled();
    });

    it("RateLimitRepository.update should use insert or replace for SQLite", async () => {
        // Mock isPg to false for SQLite behavior
        Object.defineProperty(rateLimitRepo, "isPg", { get: () => false });

        await rateLimitRepo.update({
            key: "test",
            windowStart: 100,
            count: 1,
            cost: 1,
            lastRequest: 100
        });

        expect(mockDb.runAsync).toHaveBeenCalled();
        const call = mockDb.runAsync.mock.calls[0];
        expect(call[0]).toContain("insert or replace");
    });

    it("MemoryRepository.getSectorStats should query the memories table", async () => {
        await memoryRepo.getSectorStats("user-1");

        // getSectorStats calls allUser, which in our mock calls mockDb.allUser
        expect(mockDb.allUser).toHaveBeenCalled();
        const call = mockDb.allUser.mock.calls[0];
        expect(call[0]).toContain("from " + TABLES.memories);
        expect(call[0]).toContain("group by primary_sector");
    });
});
