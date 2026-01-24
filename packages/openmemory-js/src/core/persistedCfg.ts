import { logger } from "../utils/logger";
import { q } from "./db";
import { getEncryption } from "./security";

/**
 * Retrieves an encrypted configuration from the database.
 * @param userId The user context (null for system-wide).
 * @param type The configuration type (e.g., 'openai', 'github').
 */
export async function getPersistedConfig<T>(
    userId: string | null,
    type: string,
): Promise<T | null> {
    try {
        // Ensure database is ready before accessing q object
        const { waitForDb } = await import("./db/population");
        await waitForDb();

        const row = (await q.getSourceConfig.get(userId, type)) as any;
        if (!row || !row.config || row.status === "disabled") return null;

        const enc = getEncryption();
        const decrypted = await enc.decrypt(row.config);
        return JSON.parse(decrypted) as T;
    } catch (e) {
        logger.error(`[CONFIG] Failed to load persisted config for ${type}:`, {
            error: e,
        });
        return null;
    }
}

/**
 * Stores a configuration encrypted in the database.
 * @param userId The user context (null for system-wide).
 * @param type The configuration type (e.g., 'openai', 'github').
 * @param config The configuration object to store.
 */
export async function setPersistedConfig<T>(
    userId: string | null,
    type: string,
    config: T,
    status: "enabled" | "disabled" = "enabled",
): Promise<void> {
    try {
        // Ensure database is ready before accessing q object
        const { waitForDb } = await import("./db/population");
        await waitForDb();

        const enc = getEncryption();
        const encrypted = await enc.encrypt(JSON.stringify(config));
        const now = Date.now();
        await q.insSourceConfig.run(
            userId,
            type,
            encrypted,
            status,
            now,
            now,
        );
    } catch (e) {
        logger.error(`[CONFIG] Failed to save persisted config for ${type}:`, {
            error: e,
        });
        throw e;
    }
}

/**
 * Deletes a persisted configuration.
 */
export async function deletePersistedConfig(
    userId: string | null,
    type: string,
): Promise<void> {
    // Ensure database is ready before accessing q object
    const { waitForDb } = await import("./db/population");
    await waitForDb();

    await q.delSourceConfig.run(userId, type);
}
