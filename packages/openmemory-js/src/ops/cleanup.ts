import { env } from "../core/cfg";
import { q, runAsync, TABLES, vectorStore } from "../core/db";
import { logger } from "../utils/logger";

/**
 * Prunes orphaned vectors that do not have a corresponding memory record.
 * This is critical when using Redis/Valkey for vectors and SQL for Metadata,
 * as Foreign Key constraints cannot enforce integrity across systems.
 */
export async function pruneOrphanedVectors() {
    const startTime = Date.now();
    logger.info("[MAINTENANCE] Starting Orphaned Vector Pruning...");

    try {
        if (
            env.vectorBackend === "postgres" &&
            env.metadataBackend === "postgres"
        ) {
            // Pure PG mode: We can use a fast SQL query if the FK is missing.
            // But let's check if we can just rely on the heuristic first.
            // If we are in Pure SQL mode, we might as well use SQL.
            const sql = `DELETE FROM ${TABLES.vectors} WHERE id NOT IN (SELECT id FROM ${TABLES.memories})`;
            const count = await runAsync(sql);
            if (count > 0) {
                logger.info(
                    `[MAINTENANCE] Removed ${count} orphaned vectors via SQL.`,
                );
                await q.logMaintOp.run(
                    "prune_vectors",
                    "success",
                    `Removed ${count} orphans (SQL)`,
                    Date.now(),
                );
            }
            return { count };
        }

        // Mixed Mode or Generic Mode (Iterative)
        // Optimization: Instead of fetching all 10M memory IDs at once,
        // we fetch them in batches and remove them from the candidate set.

        logger.debug("[MAINTENANCE] Fetching all vector IDs for comparison...");
        const vecIds = await vectorStore.getAllVectorIds();
        const candidateOrphans = new Set(vecIds);

        if (candidateOrphans.size === 0) {
            logger.debug("[MAINTENANCE] No vectors found in store.");
            return { count: 0 };
        }

        logger.debug(`[MAINTENANCE] Comparing ${candidateOrphans.size} vectors against database...`);

        const BATCH_SIZE_DB = 50000;
        let offset = 0;

        while (true) {
            const memRows = await q.allMemStable.all(BATCH_SIZE_DB, offset);
            if (memRows.length === 0) break;

            for (const row of memRows) {
                candidateOrphans.delete(row.id);
            }

            offset += memRows.length;
            if (candidateOrphans.size === 0) break; // All vectors accounted for

            // Yield to event loop
            if (offset % 250000 === 0) await new Promise((r) => setTimeout(r, 0));
        }

        const orphans = Array.from(candidateOrphans);

        if (orphans.length > 0) {
            logger.info(
                `[MAINTENANCE] Found ${orphans.length} orphaned vectors. Deleting in batches...`,
            );

            // Chunk deletion
            const DELETE_BATCH_SIZE = 200;
            let deleted = 0;
            for (let i = 0; i < orphans.length; i += DELETE_BATCH_SIZE) {
                const chunk = orphans.slice(i, i + DELETE_BATCH_SIZE);
                await vectorStore.deleteVectors(chunk);
                deleted += chunk.length;
                if (i % 1000 === 0) await new Promise((r) => setTimeout(r, 10)); // Yield to event loop
            }

            logger.info(
                `[MAINTENANCE] Successfully removed ${deleted} orphaned vectors.`,
            );
            await q.logMaintOp.run(
                "prune_vectors",
                "success",
                `Removed ${deleted} orphans`,
                Date.now(),
            );
            return { count: deleted };
        } else {
            logger.debug("[MAINTENANCE] No orphaned vectors found.");
            return { count: 0 };
        }
    } catch (error: unknown) {
        logger.error("[MAINTENANCE] Orphan pruning failed:", { error });
        await q.logMaintOp.run(
            "prune_vectors",
            "failed",
            (error as Error).message,
            Date.now(),
        );
        throw error;
    } finally {
        const duration = Date.now() - startTime;
        logger.debug(`[MAINTENANCE] Orphan pruning finished in ${duration}ms`);
    }
}
