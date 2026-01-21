/**
 * @file Key Rotation Operation
 * Re-encrypts data with the current primary key.
 */
import * as crypto from "crypto";
import { q } from "../core/db";
import { getEncryption } from "../core/security";
import { logger } from "../utils/logger";

export interface RotateKeysOptions {
    batchSize?: number;
    delayMs?: number;
    userId?: string; // Optional: Rotate only for specific user (not fully supported by allMem yet)
    targetVersion?: number;
}

export async function rotateKeys(options: RotateKeysOptions = {}) {
    const batchSize = options.batchSize || 100;
    const delayMs = options.delayMs || 10;
    const targetVersion = options.targetVersion || 2;
    const enc = getEncryption();

    logger.info(`[ROTATION] Starting key rotation job. Target version: ${targetVersion}`);
    const jobId = crypto.randomUUID();
    const startTime = Date.now();

    try {
        await q.logEncryptionRotation.run({
            id: jobId,
            oldVer: targetVersion - 1,
            newVer: targetVersion,
            status: "running",
            startedAt: startTime
        });
    } catch (e) {
        logger.error("[ROTATION] Failed to log start", { error: e });
    }

    let offset = 0;
    let totalProcessed = 0;
    let errors = 0;
    let rotated = 0;

    // We used to have separate 'encryption_key_version' column.
    // However, the encryption provider usually handles IVs and verification.
    // The version column acts as a cursor to know what is 'fresh'.

    while (true) {
        // Fetch batch
        // We use q.allMem directly.
        // We use q.allMem directly.

        let rows;
        if (options.userId) {
            // allMemByUser is already ordered by created_at desc. Ideally we should have a stable version too.
            // But for now, let's stick to what we have or add a stable variant if needed.
            // Actually, let's use allMemStable if userId is NOT provided, which is the common case for system rotation.
            rows = await q.allMemByUser.all(options.userId, batchSize, offset);
        } else {
            rows = await q.allMemStable.all(batchSize, offset);
        }

        if (rows.length === 0) {
            break;
        }

        logger.info(`[ROTATION] Processing batch ${offset} - ${offset + rows.length}...`);

        for (const row of rows) {
            try {
                // Check if already on target version
                // Note: db.ts interface might return snake_case or camelCase depending on usage locally?
                // q.allMem returns Promise<MemoryRow[]>. MemoryRow has camelCase keys mapped by mapRow.
                // So we access `row.encryptionKeyVersion`.
                if (row.encryptionKeyVersion && row.encryptionKeyVersion >= targetVersion) {
                    continue;
                }

                // 1. Decrypt (uses any available key)
                let plaintext = row.content;
                try {
                    plaintext = await enc.decrypt(row.content);
                } catch (e) {
                    // Start tolerant: if decryption fails, it might be plain text or corrupt.
                    // If it was already plain text (Noop), decrypt returns it.
                    // If it was encrypted with lost key, we can't save it effectively re-encrypted?
                    // We log and skip or force re-encrypt 'as is' if we assume it's valid text?
                    // Safe approach: Log error and skip.
                    logger.error(`[ROTATION] Failed to decrypt memory ${row.id}`, { error: e });
                    errors++;
                    continue;
                }

                // 2. Encrypt (uses NEW primary key)
                const newCiphertext = await enc.encrypt(plaintext);

                // 3. Update
                await q.updEncryption.run(row.id, newCiphertext, targetVersion, row.userId);
                rotated++;
            } catch (err) {
                logger.error(`[ROTATION] Error processing ${row.id}`, { error: err });
                errors++;
            }
        }

        // As we don't have a direct "update content only" exposed in `q`, 
        // I will temporarily assume I can add a specialized query to `MemoryRepository` or use `runAsync`.
        // Let's check if `runAsync` is exported.
        // `export const runAsync = ...` in `db.ts`.

        offset += rows.length;
        totalProcessed += rows.length;

        // Sleep
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }

    logger.info(`[ROTATION] Completed. Processed: ${totalProcessed}. Rotated: ${rotated}. Errors: ${errors}.`);

    try {
        const status = errors === 0 ? "completed" : "completed_with_errors";
        await q.updateEncryptionStatus.run({
            id: jobId,
            status,
            completedAt: Date.now(),
            error: errors > 0 ? `${errors} errors` : null
        });
    } catch (e) {
        logger.error("[ROTATION] Failed to log completion", { error: e });
    }

    return { processed: totalProcessed, errors };
}
