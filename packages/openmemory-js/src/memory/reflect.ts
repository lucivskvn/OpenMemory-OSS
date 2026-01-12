import { get_generator } from "../ai/adapters";
import { env } from "../core/cfg";
import { logMaintOp, q } from "../core/db";
import { registerInterval, unregisterInterval } from "../core/scheduler";
import { getEncryption } from "../core/security";
import { MemoryRow } from "../core/types";
import { stringifyJSON } from "../utils";
import { normalizeUserId, parseJSON } from "../utils";
import { logger } from "../utils/logger";
import { addHsgMemory } from "./hsg";

/**
 * Jaccard similarity between two strings based on tokens.
 */
const calculateSimilarity = (text1: string, text2: string): number => {
    const tokenize = (s: string) =>
        new Set(
            s
                .toLowerCase()
                .replace(/[^\w\s]/g, "")
                .split(/\s+/)
                .filter((x) => x.length > 0),
        );
    const set1 = tokenize(text1);
    const set2 = tokenize(text2);
    if (set1.size === 0 || set2.size === 0) return 0;

    let intersectionCount = 0;
    for (const token of set1) {
        if (set2.has(token)) intersectionCount++;
    }
    const unionSize = new Set([...set1, ...set2]).size;
    return unionSize > 0 ? intersectionCount / unionSize : 0;
};

/**
 * Clusters memories based on content similarity and sector.
 */
const clusterMemories = (
    memories: MemoryRow[],
): { memories: MemoryRow[]; count: number }[] => {
    const clusters: { memories: MemoryRow[]; count: number }[] = [];
    const usedIds = new Set<string>();

    for (const m of memories) {
        if (usedIds.has(m.id) || m.primarySector === "reflective") continue;

        let metadata: Record<string, unknown> = {};
        try {
            const raw = m.metadata
                ? typeof m.metadata === "string"
                    ? parseJSON(m.metadata)
                    : m.metadata
                : {};
            if (typeof raw === "object" && raw !== null) {
                metadata = raw as Record<string, unknown>;
            }
        } catch (e) {
            logger.debug(`[REFLECT] Cluster meta parse error for ${m.id}: `, {
                error: e,
            });
        }

        if (metadata.consolidated) continue;
        const currentCluster = { memories: [m], count: 1 };
        usedIds.add(m.id);

        for (const o of memories) {
            if (usedIds.has(o.id) || m.primarySector !== o.primarySector)
                continue;
            if (calculateSimilarity(m.content, o.content) > 0.8) {
                currentCluster.memories.push(o);
                currentCluster.count++;
                usedIds.add(o.id);
            }
        }
        if (currentCluster.count >= 2) clusters.push(currentCluster);
    }
    return clusters;
};

/**
 * Calculates salience based on cluster density, recency, and emotional tags.
 */
const calculateReflectiveSalience = (cluster: {
    memories: MemoryRow[];
    count: number;
}): number => {
    const now = Date.now();
    const densityPenalty = cluster.count / 10;
    const recencyWeightedAverage =
        cluster.memories.reduce(
            (sum: number, m: MemoryRow) =>
                sum + Math.exp(-(now - Number(m.createdAt)) / 43200000), // 12-hour decay constant
            0,
        ) / cluster.count;

    const hasEmotionalContext = cluster.memories.some((m: MemoryRow) => {
        const tags = (
            m.tags
                ? typeof m.tags === "string"
                    ? parseJSON(m.tags)
                    : m.tags
                : []
        ) as string[];
        return tags.includes("emotional");
    })
        ? 1
        : 0;

    return Math.min(
        1,
        0.6 * densityPenalty +
        0.3 * recencyWeightedAverage +
        0.1 * hasEmotionalContext,
    );
};

/**
 * Generates a summary for a cluster of memories.
 */
const summarizeCluster = async (
    cluster: { memories: MemoryRow[]; count: number },
    userId?: string | null,
): Promise<string> => {
    const sector = cluster.memories[0].primarySector;
    const count = cluster.count;
    const snippets = cluster.memories
        .map((m: MemoryRow) => m.content)
        .join("\n\n");

    const gen = await get_generator(userId);
    if (gen) {
        try {
            const prompt = `Analyze these ${count} related memories from the "${sector}" sector and synthesize a high-level cognitive pattern or insight.

Memories:
${snippets.slice(0, 3000)}

Return a concise insight (1-2 sentences) starting with "${count} ${sector} pattern detected:".`;

            return await gen.generate(prompt, { max_tokens: 150 });
        } catch (e: unknown) {
            const isRetryable = (e as Record<string, unknown>)?.retryable !== false;
            const provider = (e as Record<string, unknown>)?.provider || "unknown";
            logger.warn(`[REFLECT] AI generation failed (${provider}):`, {
                error: (e as Error).message,
                retryable: isRetryable,
            });
        }
    }

    return `${count} ${sector} pattern detected: ${snippets.substring(0, 200).replace(/\n/g, "; ")}...`;
};

/**
 * Marks source memories as consolidated and boosts their salience slightly.
 */
const processReflectionSources = async (
    ids: string[],
    userId: string | undefined | null,
) => {
    const timestamp = Date.now();
    const uid = normalizeUserId(userId);
    for (const id of ids) {
        const m = await q.getMem.get(id, uid);
        if (m) {
            let metadata: Record<string, unknown> = {};
            try {
                metadata =
                    typeof m.metadata === "string"
                        ? parseJSON(m.metadata || "{}")
                        : m.metadata || {};
            } catch (e) {
                logger.debug(`[REFLECT] Metadata parse failed for ${id}: `, {
                    error: e,
                });
            }
            metadata.consolidated = true;

            // Mark as consolidated
            // Note: tags is guaranteed string by updated db.ts types but let's be safe
            const tagsStr =
                typeof m.tags === "string"
                    ? m.tags
                    : stringifyJSON(m.tags || []);

            await q.updMem.run(
                m.content,
                m.primarySector,
                tagsStr,
                stringifyJSON(metadata),
                timestamp,
                id,
                uid,
            );

            // Refresh seen status and boost salience
            await q.updSeen.run(
                id,
                Number(m.lastSeenAt) || timestamp,
                Math.min(1, (m.salience ?? 0) * 1.1),
                timestamp,
                uid,
            );
        }
    }
};

/**
 * Runs the global reflection job, clustering and synthesizing new memories.
 */
export const runReflection = async () => {
    if (env.verbose) logger.info("[REFLECT] Starting reflection job...");
    const minThreshold = env.reflectMin || 20;

    const users = await q.getActiveUsers.all();
    if (env.verbose)
        logger.info(`[REFLECT] Found ${users.length} active users`);

    let reflectionsCreated = 0;
    let clustersFound = 0;

    for (const { userId } of users) {
        const uid = normalizeUserId(userId);
        if (!uid) continue;
        if (env.verbose) logger.info(`[REFLECT] Processing user: ${uid} `);

        const memories = await q.allMemByUser.all(uid, 100, 0);

        if (memories.length < minThreshold) {
            if (env.verbose)
                logger.info(
                    `[REFLECT] User ${userId}: Not enough memories(${memories.length}), skipping`,
                );
            continue;
        }

        // Decrypt content for analysis
        const enc = getEncryption();
        const decryptedMemories = await Promise.all(
            memories.map(async (m) => ({
                ...m,
                content: await enc.decrypt(m.content),
            })),
        );

        const clusters = clusterMemories(decryptedMemories);
        if (env.verbose)
            logger.info(
                `[REFLECT] User ${userId}: Clustered into ${clusters.length} groups`,
            );

        for (const c of clusters) {
            try {
                const text = await summarizeCluster(c, uid);
                const salience = calculateReflectiveSalience(c);
                const sourceIds = c.memories.map((m) => m.id);
                const meta = {
                    type: "auto_reflect",
                    sources: sourceIds,
                    frequency: c.count,
                    at: new Date().toISOString(),
                    userId: uid,
                };

                if (env.verbose) {
                    logger.info(
                        `[REFLECT] User ${uid}: Creating reflection in ${c.memories[0].primarySector} (Sources: ${c.count}, Salience: ${salience.toFixed(3)})`,
                    );
                }

                await addHsgMemory(
                    text,
                    stringifyJSON(["reflect:auto"]),
                    meta,
                    uid,
                );
                await processReflectionSources(sourceIds, uid);
                reflectionsCreated++;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(
                    `[REFLECT] User ${uid}: Failed to process cluster: ${msg} `,
                    { error: err },
                );
            }
        }
        if (clusters.length > 0) {
            try {
                await logMaintOp("reflect", clusters.length, uid);
            } catch {
                /* ignore */
            }
        }
        clustersFound += clusters.length;
    }

    if (env.verbose)
        logger.info(
            `[REFLECT] Job complete: created ${reflectionsCreated} reflections across users`,
        );
    return { created: reflectionsCreated, clusters: clustersFound };
};

let reflectionTimerId: string | null = null;

/**
 * Starts the reflection service.
 */
export const startReflection = () => {
    if (!env.autoReflect || reflectionTimerId) return;
    const intervalMs = (env.reflectInterval || 10) * 60000;
    reflectionTimerId = registerInterval(
        "reflection",
        async () => {
            try {
                await runReflection();
            } catch (e) {
                logger.error("[REFLECT] Job Failed:", { error: e });
            }
        },
        intervalMs,
    );
    if (env.verbose)
        logger.info(`[REFLECT] Started: every ${env.reflectInterval || 10} m`);
};

/**
 * Stops the reflection service.
 */
export const stopReflection = () => {
    if (reflectionTimerId) {
        unregisterInterval(reflectionTimerId);
        reflectionTimerId = null;
    }
};
