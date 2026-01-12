/**
 * User Personality and Activity Summarization.
 * Reflects on user memories to create a stable high-level profile summary.
 */
import { get_generator } from "../ai/adapters";
import { env } from "../core/cfg";
import { q } from "../core/db";
import { registerInterval, unregisterInterval } from "../core/scheduler";
import { MemoryRow } from "../core/types";
import { compressionEngine } from "../ops/compress";
import { normalizeUserId } from "../utils";
import { logger } from "../utils/logger";

/**
 * Generates a human-readable summary of a user's activity based on recent memories.
 */
const genUserSummary = (memories: MemoryRow[]): string => {
    if (!memories.length)
        return "User profile initializing... (No memories recorded yet)";

    const projects = new Set<string>();
    const languages = new Set<string>();
    const files = new Set<string>();

    let saves = 0;

    interface IdeMetadata {
        ideProjectName?: string;
        ide_project_name?: string;
        language?: string;
        ideFilePath?: string;
        ide_file_path?: string;
        ideEventType?: string;
        ide_event_type?: string;
    }

    for (const m of memories) {
        if (m.metadata) {
            try {
                const raw =
                    typeof m.metadata === "string"
                        ? JSON.parse(m.metadata)
                        : m.metadata;
                const metadata = raw as IdeMetadata;

                // Standardizing to camelCase but remaining flexible for legacy or external keys
                const projectName =
                    metadata.ideProjectName || metadata.ide_project_name;
                const language = metadata.language;
                const filePath = metadata.ideFilePath || metadata.ide_file_path;
                const eventType =
                    metadata.ideEventType || metadata.ide_event_type;

                if (projectName) projects.add(projectName);
                if (language) languages.add(language);
                if (filePath) {
                    const fname = filePath.split(/[\\/]/).pop();
                    if (fname) files.add(fname);
                }
                if (eventType === "save") saves++;
            } catch {
                /* ignore */
            }
        }
    }

    const projectStr =
        projects.size > 0 ? Array.from(projects).join(", ") : "Unknown Project";
    const langStr =
        languages.size > 0 ? Array.from(languages).join(", ") : "General";
    const recentFiles = Array.from(files).slice(0, 5).join(", ");
    const lastActive = memories[0].createdAt
        ? new Date(memories[0].createdAt).toLocaleString()
        : "Recently";

    return `Active in ${projectStr} using ${langStr}. Recently working on: ${recentFiles || "various files"}. Summarized from ${memories.length} events (${saves} saves). Last active: ${lastActive}.`;
};

/**
 * Fetches memories and generates a user summary asynchronously.
 * Prioritizes AI generation if available, otherwise uses local compression + heuristic.
 */
export const genUserSummaryAsync = async (userId: string): Promise<string> => {
    const uid = normalizeUserId(userId);
    if (!uid) return "User profile initializing...";

    const memories = await q.allMemByUser.all(uid, 50, 0); // Use 50 most recent
    if (!memories.length)
        return "User profile initializing... (No memories recorded yet)";

    // 1. Try AI Summarization (if available)
    const gen = await get_generator(uid);
    if (gen) {
        try {
            const context = memories
                .map((m: MemoryRow) => m.content)
                .join("\n---\n");
            // Local compression first to save context tokens
            const compressed = compressionEngine.auto(context, uid).comp;

            const prompt = `Based on the following user activity memories, generate a concise, professional personality and context summary (2-3 sentences). Focus on projects, technical stack, and recent focus areas.\n\nMemories:\n${compressed.slice(0, 4000)}`;

            const aiSummary = await gen.generate(prompt, {
                max_tokens: 200,
                temperature: 0.5,
            });
            if (aiSummary) return aiSummary;
        } catch (e: unknown) {
            const err = e as { retryable?: boolean; provider?: string; message?: string };
            const isRetryable = err.retryable !== false;
            const provider = err.provider || "unknown";
            logger.warn(`[USER_SUMMARY] AI generation failed (${provider}):`, {
                error: err.message || String(e),
                retryable: isRetryable,
            });
        }
    }

    // 2. Fallback to Heuristic + Local Compression
    return genUserSummary(memories);
};

/**
 * Updates the persisted user summary in the database.
 */
export const updateUserSummary = async (userId: string): Promise<void> => {
    try {
        const uid = normalizeUserId(userId);
        if (!uid) return;
        const summary = await genUserSummaryAsync(uid);
        const timestamp = Date.now();

        const existing = await q.getUser.get(uid);
        if (!existing) {
            await q.insUser.run(uid, summary, 0, timestamp, timestamp);
        } else {
            await q.updUserSummary.run(uid, summary, timestamp);
        }
    } catch (e) {
        logger.error(`[USER_SUMMARY] Fatal error for ${userId}:`, { error: e });
    }
};

/**
 * Automatically updates summaries for all active users.
 */
export const autoUpdateUserSummaries = async (): Promise<{
    updated: number;
}> => {
    const users = await q.getActiveUsers.all();
    const userIds = users
        .map((u: { userId: string }) => u.userId)
        .filter((id: string): id is string => !!id);

    let updated = 0;
    if (env.verbose && userIds.length > 0)
        logger.info(
            `[USER_SUMMARY] Updating summaries for ${userIds.length} users...`,
        );

    // Concurrency limit (Sustainability)
    const concurrency = 5;
    const chunkedUsers = [];
    for (let i = 0; i < userIds.length; i += concurrency) {
        chunkedUsers.push(userIds.slice(i, i + concurrency));
    }

    for (const chunk of chunkedUsers) {
        await Promise.all(chunk.map(async (userId) => {
            try {
                await updateUserSummary(userId);
                updated++;
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.error(`[USER_SUMMARY] Failed for ${userId}: ${msg}`, {
                    error: e,
                });
            }
        }));
    }

    if (env.verbose && updated > 0)
        logger.info(`[USER_SUMMARY] Completed. Updated: ${updated}`);
    return { updated };
};

let summaryTimerId: string | null = null;

/**
 * Starts the background interval for user summary reflection.
 */
export const startUserSummaryReflection = () => {
    if (summaryTimerId) return;
    const intervalMs = (env.userSummaryInterval || 30) * 60000;
    summaryTimerId = registerInterval(
        "user-summary",
        async () => {
            try {
                await autoUpdateUserSummaries();
            } catch (e) {
                if (env.verbose)
                    logger.error("[USER_SUMMARY] Background update failed", {
                        error: e,
                    });
            }
        },
        intervalMs,
    );
};

/**
 * Stops the background interval for user summary reflection.
 */
export const stopUserSummaryReflection = () => {
    if (summaryTimerId) {
        unregisterInterval(summaryTimerId);
        summaryTimerId = null;
    }
};
