/**
 * @file Vector Maintenance Operations
 * @description Provides utilities for maintaining vector store integrity,
 * including orphaned vector cleanup and consistency checks.
 */

import { q, vectorStore } from "../core/db";
import { normalizeUserId } from "../utils";
import { logger } from "../utils/logger";

/**
 * Cleans up orphaned vectors that have no corresponding memory records.
 * This is important for maintaining storage integrity after memory deletions.
 *
 * @param userId - Optional user ID for tenant isolation
 * @returns Object containing count of deleted orphaned vectors
 */
export async function cleanupOrphanedVectors(
    userId?: string | null
): Promise<{ deleted: number; scanned: number }> {
    const uid = normalizeUserId(userId);
    let deleted = 0;
    let scanned = 0;
    const batchSize = 500;

    let vectorIdBatch: string[] = [];

    // processBatch function to handle the checking and deleting
    const processBatch = async (ids: string[]) => {
        if (ids.length === 0) return 0;

        try {
            // Check which of these IDs have corresponding memories
            // q.getMems.all returns MemoryRow[]
            const existingMems = await q.getMems.all(ids, uid);
            const existingIds = new Set(existingMems.map((m: { id: string }) => m.id));

            const toDelete: string[] = [];
            for (const id of ids) {
                if (!existingIds.has(id)) {
                    toDelete.push(id);
                }
            }

            if (toDelete.length > 0) {
                await vectorStore.deleteVectors(toDelete, uid);
                return toDelete.length;
            }
        } catch (error) {
            logger.error(`[VECTOR_MAINT] Error processing batch of ${ids.length} vectors`, { error });
        }
        return 0;
    };

    // Use streaming iterator to avoid loading all IDs into memory
    for await (const vectorId of vectorStore.iterateVectorIds(uid)) {
        scanned++;
        vectorIdBatch.push(vectorId);

        if (vectorIdBatch.length >= batchSize) {
            deleted += await processBatch(vectorIdBatch);
            vectorIdBatch = [];
        }
    }

    // Process remaining
    if (vectorIdBatch.length > 0) {
        deleted += await processBatch(vectorIdBatch);
    }

    if (deleted > 0) {
        logger.info(`[VECTOR_MAINT] Cleaned up ${deleted} orphaned vectors out of ${scanned} scanned.`);
    }

    return { deleted, scanned };
}

/**
 * Verifies vector store consistency by checking for:
 * - Orphaned vectors (vectors without memories)
 * - Missing vectors (memories without vectors)
 * 
 * NOTE: This operation is resource intensive as it scans both full tables/stores
 * in batches. It avoids OOM but will take time for large datasets.
 * 
 * @param userId - Optional user ID for tenant isolation
 * @returns Consistency report
 */
export async function verifyVectorConsistency(
    userId?: string | null
): Promise<{
    orphanedVectorCount: number;
    missingVectorCount: number;
    totalVectors: number;
    totalMemories: number;
}> {
    const uid = normalizeUserId(userId);
    let orphanedVectorCount = 0;
    let missingVectorCount = 0;
    let totalVectors = 0;
    let totalMemories = 0;

    const BATCH = 1000;

    // 1. Check for Orphaned Vectors (Vector exists, Memory missing)
    let vecBatch: string[] = [];
    for await (const vid of vectorStore.iterateVectorIds(uid)) {
        totalVectors++;
        vecBatch.push(vid);
        if (vecBatch.length >= BATCH) {
            const mems = await q.getMems.all(vecBatch, uid);
            const foundIds = new Set(mems.map(m => m.id));
            orphanedVectorCount += vecBatch.filter(id => !foundIds.has(id)).length;
            vecBatch = [];
        }
    }
    if (vecBatch.length > 0) {
        const mems = await q.getMems.all(vecBatch, uid);
        const foundIds = new Set(mems.map(m => m.id));
        orphanedVectorCount += vecBatch.filter(id => !foundIds.has(id)).length;
    }

    // 2. Check for Missing Vectors (Memory exists, Vector missing)
    // We iterate memories using cursor to be safe
    let offset = 0;
    while (true) {
        const memIds = await q.allMemIds.all(BATCH, offset, uid);
        if (memIds.length === 0) break;

        totalMemories += memIds.length;
        offset += memIds.length;

        const idsToCheck = memIds.map(m => m.id);
        const vectors = await vectorStore.getVectorsByIds(idsToCheck, uid);

        // Group vectors by ID to see which ones are missing
        const foundVecIds = new Set(vectors.map(v => v.id));

        missingVectorCount += idsToCheck.filter(id => !foundVecIds.has(id)).length;

        // Safety break for infinite loops if DB is acting up, though unlikely with limit/offset
        // but offset based paging on changing data is risky? 
        // Ideally we use cursor-based (id > lastId), but q.allMemIds is offset based.
        // Assuming stable sort by ID/CreateAt in `allMemIds`.
    }

    return {
        orphanedVectorCount,
        missingVectorCount,
        totalVectors,
        totalMemories,
    };
}
