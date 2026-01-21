import { env } from "../core/cfg";
import { allAsync, q, runAsync, TABLES, vectorStore } from "../core/db";
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
            const sql = `DELETE FROM ${TABLES.vectors} v WHERE NOT EXISTS (SELECT 1 FROM ${TABLES.memories} m WHERE m.id = v.id)`;
            const count = await runAsync(sql);
            if (count > 0) {
                logger.info(
                    `[MAINTENANCE] Removed ${count} orphaned vectors via SQL.`,
                );
                await q.logMaintOp.run({
                    op: "prune_vectors",
                    status: "success",
                    details: `Removed ${count} orphans (SQL)`,
                    ts: Date.now(),
                });
            }
            return { count };
        }

        // Mixed Mode or Generic Mode (Iterative & Streaming)
        // Optimized: Uses iterateVectorIds to stream IDs instead of loading all into memory.
        logger.debug("[MAINTENANCE] Starting streaming verification of vectors...");

        let scanned = 0;
        let deleted = 0;
        const BATCH_SIZE = 500; // Safe for SQLite parameter limits
        let batch: string[] = [];

        async function processBatch(ids: string[]) {
            if (ids.length === 0) return 0;
            // Check existence in DB
            const placeholders = ids.map(() => "?").join(",");
            // Note: Postgres uses $1, $2... but db_utils/applySqlUser handles minimal things?
            // Actually applySqlUser is for vector store. Core `q` uses Kysely or raw?
            // `q` is Kysely. We should use `q` or `allAsync`.
            // Let's use `allAsync` with raw SQL for performance and simplicity here, 
            // OR use Kysely `q.selectFrom('memories').select('id').where('id', 'in', ids).execute()`.

            // Using `allAsync` to match existing style in this file (which imports tables)
            // But wait, `q` is available.
            // Let's use `allAsync` as it's cleaner for raw checks.
            const isPg = env.metadataBackend === 'postgres';
            const ph = isPg ? ids.map((_, i) => `$${i + 1}`).join(",") : ids.map(() => "?").join(",");
            const sql = `SELECT id FROM ${TABLES.memories} WHERE id IN (${ph})`;

            // Wait, import is `allAsync`.
            const foundRows = await allAsync<{ id: string }>(sql, ids);
            const foundSet = new Set(foundRows.map(r => r.id));

            const orphans = ids.filter(id => !foundSet.has(id));
            if (orphans.length > 0) {
                await vectorStore.deleteVectors(orphans);
            }
            return orphans.length;
        }

        const iterator = await vectorStore.iterateVectorIds(null);
        // Note: manager returns async generator, so we can iterate.
        for await (const id of iterator) {
            batch.push(id);
            scanned++;
            if (batch.length >= BATCH_SIZE) {
                deleted += await processBatch(batch);
                batch = [];
                // Yield to event loop occasionally
                if (scanned % 5000 === 0) await new Promise(r => setTimeout(r, 0));
            }
        }

        // Process remaining
        if (batch.length > 0) {
            deleted += await processBatch(batch);
        }

        if (deleted > 0) {
            logger.info(
                `[MAINTENANCE] Successfully removed ${deleted} orphaned vectors (Scanned: ${scanned}).`,
            );
            await q.logMaintOp.run({
                op: "prune_vectors",
                status: "success",
                details: `Removed ${deleted} orphans (Streaming)`,
                ts: Date.now(),
            });
            return { count: deleted };
        } else {
            logger.debug(`[MAINTENANCE] No orphaned vectors found (Scanned: ${scanned}).`);
            return { count: 0 };
        }
    } catch (error: unknown) {
        logger.error("[MAINTENANCE] Orphan pruning failed:", { error });
        await q.logMaintOp.run({
            op: "prune_vectors",
            status: "failed",
            details: (error as Error).message,
            ts: Date.now(),
        });
        throw error;
    } finally {
        const duration = Date.now() - startTime;
        logger.debug(`[MAINTENANCE] Orphan pruning finished in ${duration}ms`);
    }
}
