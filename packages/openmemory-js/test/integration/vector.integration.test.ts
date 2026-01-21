import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { q, vectorStore, closeDb, waitReady, getContextId } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { addMemory } from "../../src/memory/hsg";
import { cleanupOrphanedVectors } from "../../src/ops/vector_maint";
import { getUniqueDbPath, waitForDb } from "../test_utils";
import { SqlVectorStore } from "../../src/core/vector/sql";
import { TABLES } from "../../src/core/db_access";
import fs from "node:fs";

describe("Vector Storage Integration (Unified)", () => {
    const userId = "test-vector-user";
    const DB_PATH = getUniqueDbPath("vector_integration");

    beforeAll(async () => {
        // Enable verbose logging for debugging
        const { configureLogger } = await import("../../src/utils/logger");
        configureLogger({ verbose: true, mode: "development" });

        // Reset environment
        process.env.OM_DB_PATH = DB_PATH;
        process.env.OM_METADATA_BACKEND = "sqlite";
        process.env.OM_EMBEDDING_PROVIDER = "synthetic";

        // Ensure all components are closed and state is cleared
        await closeDb();
        const { cleanupVectorStores } = await import("../../src/core/vector/manager");
        await cleanupVectorStores(getContextId());

        // Reload config and wait for a fresh DB init
        reloadConfig();
        await waitForDb();

        // Trigger fresh vector store init
        const { getVectorStore } = await import("../../src/core/vector/manager");
        getVectorStore();
    });

    afterAll(async () => {
        await closeDb();
        if (fs.existsSync(DB_PATH)) {
            try {
                fs.unlinkSync(DB_PATH);
                if (fs.existsSync(DB_PATH + "-shm")) fs.unlinkSync(DB_PATH + "-shm");
                if (fs.existsSync(DB_PATH + "-wal")) fs.unlinkSync(DB_PATH + "-wal");
            } catch (e) { }
        }
    });

    describe("Core Operations", () => {
        it("should perform a round-trip store and get", async () => {
            const testId = "v-1";
            const vec = new Array(768).fill(0.1);
            await vectorStore.storeVector(testId, "episodic", vec, 768, userId, { type: "test" });

            const retrieved = await vectorStore.getVector(testId, "episodic", userId);
            expect(retrieved).not.toBeNull();
            expect(retrieved?.dim).toBe(768);
            expect(retrieved?.metadata).toEqual({ type: "test" });
        });

        it("should search for similar vectors", async () => {
            const vec = new Array(768).fill(0.1);
            const results = await vectorStore.searchSimilar("episodic", vec, 5, userId);
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].score).toBeGreaterThan(0.99);
        });

        it("should filter by metadata", async () => {
            const vec = new Array(768).fill(0.1);
            const match = await vectorStore.searchSimilar("episodic", vec, 5, userId, { metadata: { type: "test" } });
            expect(match.length).toBeGreaterThan(0);

            const noMatch = await vectorStore.searchSimilar("episodic", vec, 5, userId, { metadata: { type: "wrong" } });
            expect(noMatch.length).toBe(0);
        });
    });

    describe("Maintenance & Integrity", () => {
        it("should correctly identify and remove orphaned vectors", async () => {
            const orphanId = "orphan-" + Date.now();
            await vectorStore.storeVector(orphanId, "episodic", new Array(768).fill(0), 768, userId);

            // Run cleanup
            const result = await cleanupOrphanedVectors();
            expect(result.deleted).toBeGreaterThanOrEqual(1);

            // Verify gone
            const ids = await vectorStore.getAllVectorIds();
            expect(ids.has(orphanId)).toBe(false);
        });

        it("should not delete valid vectors", async () => {
            const mem = await addMemory("Persistent test memory", userId);
            const result = await cleanupOrphanedVectors();
            const ids = await vectorStore.getAllVectorIds();
            expect(ids.has(mem.id)).toBe(true);
        });
    });
});
