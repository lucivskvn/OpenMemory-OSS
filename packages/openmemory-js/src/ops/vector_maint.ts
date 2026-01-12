/**
 * @file Maintenance logic for vector storage.
 * Ensures Integrity by removing orphaned vectors that no longer have matching memory records.
 */
import { q } from "../core/db";
import { vectorStore } from "../core/db";
import { logger } from "../utils/logger";

/**
 * Identifies and removes vectors from the vector store that do not have a corresponding entry in the memories table.
 * This is crucial for long-term Sustainability and Integrity of the vector search.
 */
export async function cleanupOrphanedVectors(): Promise<{ deleted: number }> {
    logger.info("[VectorMaint] Starting orphaned vector cleanup...");

    // 1. Get all vector IDs from the vector store
    // This returns a Set of distinct IDs across all sectors/users (if no userId provided)
    const vectorIds = await vectorStore.getAllVectorIds();
    if (vectorIds.size === 0) {
        logger.info("[VectorMaint] No vectors found. Skipping cleanup.");
        return { deleted: 0 };
    }

    const allIds = Array.from(vectorIds);
    let deletedCount = 0;

    // 2. Batch check against the memories table
    // We process in chunks to avoid large query overhead
    const CHUNK_SIZE = 500;
    for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
        const chunk = allIds.slice(i, i + CHUNK_SIZE);

        // Find which IDs from this chunk ACTUALLY exist in memories
        const existingMems = await q.getMems.all(chunk, undefined); // undefined user means global check
        const existingIds = new Set(existingMems.map(m => m.id));

        // Those in vector store but NOT in memories are orphans
        const orphans = chunk.filter(id => !existingIds.has(id));

        if (orphans.length > 0) {
            logger.warn(`[VectorMaint] Found ${orphans.length} orphaned vectors. Deleting...`);
            await vectorStore.deleteVectors(orphans);
            deletedCount += orphans.length;
        }
    }

    logger.info(`[VectorMaint] Cleanup complete. Removed ${deletedCount} orphaned vectors.`);
    return { deleted: deletedCount };
}
