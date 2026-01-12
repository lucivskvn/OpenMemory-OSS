/**
 * @file Maintenance Operations for OpenMemory.
 * Handles background tasks like pruning low-salience memories, training classifiers, and applying decay.
 */
import { env } from "../core/cfg";
import { getVectorStore, q } from "../core/db";
import { LearnedClassifier } from "../core/learned_classifier";
import { normalizeUserId, now } from "../utils";
import { DistributedLock } from "../utils/lock";
import { logger } from "../utils/logger";
import { bufferToVector } from "../utils/vectors";
import { applyDecay } from "./dynamics";

/**
 * Helper to log maintenance operation statistics.
 */
const logStat = async (op: string, count: number, userId?: string | null) => {
    return q.logMaintOp.run(
        op,
        "success",
        `Affected: ${count}`,
        now(),
        normalizeUserId(userId),
    );
};

/**
 * Wraps a background job in a safe try-catch block.
 * Prevents unhandled rejections from crashing the process.
 */
export async function safeJob<T>(
    jobName: string,
    task: (signal?: AbortSignal) => Promise<T>,
    userId?: string | null,
    signal?: AbortSignal,
): Promise<T | null> {
    const uid = normalizeUserId(userId);
    try {
        if (signal?.aborted) return null;
        return await task(signal);
    } catch (e) {
        if (signal?.aborted && (e instanceof Error && e.name === "AbortError")) {
            logger.info(`[BackgroundJob] '${jobName}' aborted gracefully.`);
            return null;
        }
        logger.error(`[BackgroundJob] '${jobName}' failed unexpectedly:`, {
            error: e,
            userId: uid,
        });
        return null; // Swallow error to keep process alive
    }
}

/**
 * Trains/Updates the sector classifier model for a specific user.
 * Fetches existing memories, extracts vectors and labels, and trains the model.
 * 
 * @param userId The user ID to train for
 * @param epochs Number of training epochs
 */
export async function trainUserClassifier(userId: string, epochs = 20, signal?: AbortSignal) {
    const uid = normalizeUserId(userId);
    if (!uid) return null;

    if (signal?.aborted) return null;

    if (env.verbose) {
        logger.info(`[Maintenance] Training classifier for user: ${uid}`);
    }

    // 1. Fetch training data (memories with embeddings)
    const data = await q.getTrainingData.all(uid, 10000); // Limit to 10k for now

    if (signal?.aborted) return null;

    if (data.length < 10) {
        if (env.verbose) {
            logger.info(
                `[Maintenance] Not enough data to train classifier for ${uid} (${data.length} samples)`,
            );
        }
        return null;
    }

    // 2. Format data for training
    const trainingSamples = data.map((d) => ({
        vector: bufferToVector(d.meanVec),
        label: d.primarySector,
    }));

    // 3. Get existing model if any
    const existing = await q.getClassifierModel.get(uid);
    let existingModel = undefined;
    if (existing) {
        try {
            existingModel = {
                userId: uid,
                weights: JSON.parse(existing.weights),
                biases: JSON.parse(existing.biases),
                version: existing.version,
                updatedAt: existing.updatedAt,
            };
        } catch (e) {
            logger.error(
                `[Maintenance] Error parsing existing model for ${uid}:`,
                { error: e },
            );
        }
    }

    if (signal?.aborted) return null;

    // Distributed Lock for Training
    const lock = new DistributedLock(`train_classifier:${uid}`);
    if (!(await lock.acquire(60000))) { // 1 min lock
        logger.warn(`[Maintenance] Skipping training for ${uid}: lock held.`);
        return null;
    }

    try {
        // 4. Train the model
        const newModel = await LearnedClassifier.train(
            trainingSamples,
            existingModel,
            0.01,
            epochs,
        );

        if (signal?.aborted) return null;

        // 5. Save the model back to DB
        await q.insClassifierModel.run(
            uid,
            JSON.stringify(newModel.weights),
            JSON.stringify(newModel.biases),
            (existing?.version || 0) + 1,
            now(),
        );

        if (env.verbose) {
            logger.info(
                `[Maintenance] Successfully trained and saved model for ${uid}. Samples: ${data.length}`,
            );
        }
        return newModel;
    } finally {
        await lock.release();
    }
}

/**
 * Maintenance job to retrain classifiers for all active users.
 * Parallelized with controlled concurrency to improve performance.
 */
export async function maintenanceRetrainAll(signal?: AbortSignal) {
    // SECURITY: This is a system-level job that iterates across all users.
    // Ensure it only runs in trusted contexts (e.g. internal scheduler).

    const BATCH_SIZE = 50;
    let offset = 0;
    let totalProcessed = 0;

    if (env.verbose) {
        logger.info(`[Maintenance] Starting routine retraining (paginated)...`);
    }

    const CONCURRENCY = 3; // Process 3 users at a time within the batch

    while (true) {
        if (signal?.aborted) break;

        // Fetch batch of users
        const users = await q.getUsers.all(BATCH_SIZE, offset);
        if (users.length === 0) break;

        for (let i = 0; i < users.length; i += CONCURRENCY) {
            if (signal?.aborted) break;
            const batch = users.slice(i, i + CONCURRENCY);
            await Promise.all(
                batch.map(async ({ userId }) => {
                    if (!userId || signal?.aborted) return;
                    await safeJob(`retrain:${userId}`, (s) => trainUserClassifier(userId, 20, s), userId, signal);
                }),
            );
        }

        totalProcessed += users.length;
        offset += BATCH_SIZE;

        if (env.verbose) {
            logger.info(`[Maintenance] Processed ${totalProcessed} users...`);
        }

        // Safety break for extremely large sets (optional, but good for stability)
        if (totalProcessed > 100000) {
            logger.warn("[Maintenance] Retrain limit reached (100k). Aborting to prevent long-running lock.");
            break;
        }
    }

    if (env.verbose) {
        logger.info(`[Maintenance] Retraining complete. Total users: ${totalProcessed}`);
    }
}

/**
 * Prunes memories with salience below a certain threshold.
 * Helps maintain performance by removing "forgotten" data.
 * Ensures vectors are also cleaned up.
 * 
 * @param threshold Salience threshold (default 0.05)
 * @param userId Optional user scoping
 */
export async function pruneLowSalienceMemories(
    threshold = 0.05,
    userId?: string | null,
    signal?: AbortSignal,
) {
    const uid = normalizeUserId(userId);
    if (env.verbose) {
        logger.info(
            `[Maintenance] Pruning memories with salience < ${threshold} for ${uid || "system"}`,
        );
    }
    // Granular lock to prevent overlapping prunes
    const lock = new DistributedLock(`prune:${uid || "system"}`);
    if (!(await lock.acquire(60000))) {
        if (env.verbose) logger.warn(`[Maintenance] Skipping prune for ${uid || "system"}: lock held.`);
        return 0;
    }

    try {
        let total = 0;

        // Process in batches to avoid OOM
        let iterations = 0;
        const MAX_ITERATIONS = 100; // Safety cap to prevent infinite loops

        while (iterations < MAX_ITERATIONS) {
            if (signal?.aborted) break;
            iterations++;
            // 1. Get candidate IDs
            const items = await q.getLowSalienceMemories.all(
                threshold,
                500,
                uid,
            );
            if (items.length === 0) break;

            const ids = items.map((i) => i.id);

            if (signal?.aborted) break;

            // 2. Delete from Vector Store (Valkey/PG)
            try {
                await getVectorStore().deleteVectors(ids, uid);
            } catch (e) {
                logger.warn("[Maintenance] Failed to delete vectors during prune", {
                    error: e,
                });
                // Continue to delete from DB anyway to avoid inconsistencies
            }

            if (signal?.aborted) break;

            // 3. Delete from DB
            await q.delMems.run(ids, uid);

            total += ids.length;
            if (env.verbose) {
                logger.info(
                    `[Maintenance] Pruned batch of ${ids.length}, total: ${total} (iteration: ${iterations})`,
                );
            }
        }

        if (iterations >= MAX_ITERATIONS) {
            logger.warn(
                `[Maintenance] Pruning reached MAX_ITERATIONS (${MAX_ITERATIONS}) for ${uid || "system"}. Some data may remain.`,
            );
        }

        return total;
    } finally {
        await lock.release();
    }
}

/**
 * Removes waypoints that refer to non-existent memories.
 */
export async function cleanupOrphans() {
    const lock = new DistributedLock("cleanup:orphans");
    if (!(await lock.acquire(60000))) return 0;

    try {
        if (env.verbose) logger.info("[Maintenance] Cleaning orphans...");
        const cnt = await q.delOrphanWaypoints.run();
        if (cnt > 0 && env.verbose) logger.info(`[Maintenance] Removed ${cnt} orphan waypoints`);
        return cnt;
    } catch (e) {
        logger.error("[Maintenance] Orphan cleanup failed:", { error: e });
        return 0;
    } finally {
        await lock.release();
    }
}

/**
 * Executes a full maintenance cycle:
 * 1. Apply dual-phase decay
 * 2. Prune low-salience memories (GC)
 * 3. Retrain user classifiers
 * 
 * @param userId Optional user scoping
 */
export async function runMaintenanceRoutine(userId?: string | null, signal?: AbortSignal) {
    const uid = normalizeUserId(userId);
    const start = now();

    // Acquire distributed lock for system-wide maintenance
    const lockName = uid ? `maintenance:${uid}` : "system:maintenance";
    const lock = new DistributedLock(lockName);

    // 30 minute TTL for maintenance tasks
    const acquired = await lock.acquire(1800000);
    if (!acquired) {
        if (env.verbose) {
            logger.info(
                `[Maintenance] Skipping routine for ${uid || "system"}: another instance is running.`,
            );
        }
        return;
    }

    if (signal?.aborted) {
        await lock.release();
        return;
    }

    logger.info(`[Maintenance] Starting routine for ${uid || "system"}...`);

    try {
        // 1. Decay (Strictly scoped to user if provided)
        const decayCount = await applyDecay(uid);
        await logStat("decay", decayCount, uid);

        if (signal?.aborted) return;

        // 2. GC (Strictly scoped to user if provided)
        const gcCount = await pruneLowSalienceMemories(0.05, uid, signal);
        await logStat("consolidate", gcCount, uid);

        if (signal?.aborted) return;

        // 3. Cleanup Orphans (System-wide only)
        if (!uid) {
            await cleanupOrphans();
        }

        if (signal?.aborted) return;

        // 3. Retrain (If uid provided, train only that user; else retrain all)
        if (uid) {
            await trainUserClassifier(uid, 20, signal);
            await logStat("reflect", 1, uid);
        } else {
            // Only admins or system jobs should reach here with uid=undefined
            await maintenanceRetrainAll(signal);
            const userCount = (await q.getActiveUsers.all()).length;
            await logStat("reflect", userCount, undefined);
        }

        const duration = now() - start;
        logger.info(`[Maintenance] Maintenance completed in ${duration}ms`);

        await q.insMaintLog.run(
            uid,
            "success",
            `Duration: ${duration}ms`,
            start,
        );
    } catch (e) {
        logger.error(`[Maintenance] Routine failed:`, { error: e });
        await q.insMaintLog.run(
            uid,
            "error",
            e instanceof Error ? e.message : String(e),
            start,
        );
        throw e;
    } finally {
        await lock.release();
    }
}
