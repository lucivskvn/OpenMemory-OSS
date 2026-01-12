/**
 * @file Ingestion Operations for OpenMemory.
 * Handles document extraction, summarization, chunking, and hierarchical storage.
 */
import { get_generator } from "../ai/adapters";
import { q, transaction } from "../core/db";
import { triggerMaintenance } from "../core/scheduler";
import { IngestionConfig, IngestionResult } from "../core/types";
import { addHsgMemories, addHsgMemory } from "../memory/hsg";
import { normalizeUserId, now, stringifyJSON } from "../utils";
import { splitText } from "../utils/chunking";
import { logger } from "../utils/logger";
import { compressionEngine } from "./compress";
import { ExtractionResult, extractText, extractURL } from "./extract";

const DEFAULT_LARGE_THRESHOLD = 12000;
const DEFAULT_SECTION_SIZE = 4000;

// Adaptive Maintenance Triggers
let ingestionCounter = 0;
const REFLECTION_TRIGGER_THRESHOLD = 20;
const DECAY_TRIGGER_THRESHOLD = 50;

/**
 * Triggers background maintenance tasks based on ingestion frequency.
 */
function triggerPostIngestMaintenance() {
    ingestionCounter++;
    // Use setImmediate if available (Node) or setTimeout (Bun/Browser) to ensure it runs out-of-band
    const trigger = (task: "reflect" | "decay") => {
        const msg = `[INGEST] Triggering background ${task} maintenance (counter: ${ingestionCounter})`;
        logger.info(msg);

        if (typeof setImmediate !== 'undefined') {
            setImmediate(() => void triggerMaintenance(task));
        } else {
            setTimeout(() => void triggerMaintenance(task), 0);
        }
    };

    if (ingestionCounter % REFLECTION_TRIGGER_THRESHOLD === 0) {
        trigger("reflect");
    }
    if (ingestionCounter % DECAY_TRIGGER_THRESHOLD === 0) {
        trigger("decay");
    }
}

/**
 * Creates the root memory for a document or URL.
 */
async function createRootMemory(
    text: string,
    extraction: ExtractionResult,
    metadata?: Record<string, unknown>,
    userId?: string | null,
    config?: IngestionConfig,
    overrides?: { id?: string; createdAt?: number },
) {
    const uid = normalizeUserId(userId);
    let summarySnippet = "";

    // Strategy 1: Heuristic/Syntactic Compression (Extreme Token Savings)
    const useFast = config?.fastSummarize ?? true;
    if (useFast) {
        summarySnippet = compressionEngine.compress(text, "semantic", uid).comp;
        if (summarySnippet.length > 800)
            summarySnippet = summarySnippet.slice(0, 800) + "...";
    } else {
        // Strategy 2: AI Summarization (High Accuracy, Higher Cost)
        const gen = await get_generator(uid);
        if (gen && text.length > 300) {
            try {
                const prompt = `Summarize the following document into a concise paragraph (max 3 sentences) capturing its core topic and key details:\n\n${text.slice(0, 8000)}`;
                summarySnippet = await gen.generate(prompt, {
                    max_tokens: 250,
                });
            } catch (e: unknown) {
                logger.warn(
                    `[INGEST] AI summarization failed, falling back to compression:`,
                    { error: e },
                );
                summarySnippet =
                    compressionEngine
                        .compress(text, "semantic", uid)
                        .comp.slice(0, 800) + "...";
            }
        } else {
            summarySnippet = text.slice(0, 500) + "...";
        }
    }

    const contentType =
        (
            extraction.metadata.contentType as string | undefined
        )?.toUpperCase() || "DOCUMENT";
    const sectionCount = Math.ceil(
        text.length / (config?.secSz || DEFAULT_SECTION_SIZE),
    );
    const content = `[Document: ${contentType}]\n\n${summarySnippet}\n\n[Full content split across ${sectionCount} sections]`;

    const res = await addHsgMemory(
        content,
        stringifyJSON([]),
        {
            ...metadata,
            ...extraction.metadata,
            isRoot: true,
            ingestionStrategy: "root-child",
            sector: metadata?.sector || "reflective",
        },
        uid,
        overrides,
    );

    return res.id;
}

/**
 * Unified logic for root-child strategy.
 */
async function ingestRootChild(
    text: string,
    extraction: ExtractionResult,
    metadata: Record<string, unknown> | undefined,
    config: IngestionConfig | undefined,
    userId: string | null | undefined,
    overrides?: { id?: string; createdAt?: number },
): Promise<{ rootId: string; childCount: number }> {
    const uid = normalizeUserId(userId);
    const rootId = await createRootMemory(text, extraction, metadata, userId, config, overrides);

    const size = config?.secSz || DEFAULT_SECTION_SIZE;
    const sections = splitText(text, size);

    const childItems = sections.map((section, i) => ({
        content: section,
        metadata: {
            ...metadata,
            isChild: true,
            sectionIndex: i,
            totalSections: sections.length,
            parentId: rootId,
            ingestedAt: overrides?.createdAt || now(),
        },
    }));

    const childResults = await addHsgMemories(childItems, uid);

    const waypoints = childResults.map((child) => ({
        srcId: rootId,
        dstId: child.id,
        userId: uid,
        weight: 1.0,
        createdAt: now(),
        updatedAt: now(),
    }));

    await q.insWaypoints.run(waypoints);
    return { rootId, childCount: sections.length };
}

/**
 * Ingests a raw document (text or buffer), optionally splitting it into hierarchical chunks.
 */
export async function ingestDocument(
    contentType: string,
    data: string | Buffer,
    metadata?: Record<string, unknown>,
    config?: IngestionConfig,
    userId?: string | null,
    overrides?: { id?: string; createdAt?: number },
): Promise<IngestionResult> {
    const threshold = config?.lgThresh || DEFAULT_LARGE_THRESHOLD;
    const uid = normalizeUserId(userId);

    const extraction = await extractText(contentType, data);
    const { text, metadata: extractionMetadata } = extraction;
    if (!text || text.trim().length === 0) {
        throw new Error("Ingestion Failed: Extracted content is empty");
    }

    const estimatedTokens = Number(extractionMetadata.estimatedTokens) || 0;
    const useRootChild = config?.forceRoot || estimatedTokens > threshold;

    return await transaction.run(async () => {
        let rootMemoryId: string;
        let childCount = 0;
        let strategy: "single" | "root-child";

        if (!useRootChild) {
            strategy = "single";
            const result = await addHsgMemory(
                text,
                stringifyJSON([]),
                {
                    ...metadata,
                    ...extractionMetadata,
                    ingestionStrategy: "single",
                    ingestedAt: overrides?.createdAt || now(),
                },
                uid,
                overrides,
            );
            rootMemoryId = result.id;
        } else {
            strategy = "root-child";
            // For root-child, the root ID is the one overridden if provided
            const res = await ingestRootChild(text, extraction, metadata, config, userId, overrides);
            rootMemoryId = res.rootId;
            childCount = res.childCount;
            logger.info(`[INGEST] Document: ${estimatedTokens} tokens, split into ${childCount} sections`);
        }

        triggerPostIngestMaintenance();

        return {
            rootMemoryId,
            childCount,
            totalTokens: estimatedTokens,
            strategy,
            extraction: extractionMetadata,
        };
    });
}

/**
 * Ingests content from a URL by extracting text and metadata.
 */
export async function ingestUrl(
    url: string,
    metadata?: Record<string, unknown>,
    config?: IngestionConfig,
    userId?: string | null,
    overrides?: { id?: string; createdAt?: number },
): Promise<IngestionResult> {
    const extraction = await extractURL(url);
    const threshold = config?.lgThresh || DEFAULT_LARGE_THRESHOLD;
    const estimatedTokens = Number(extraction.metadata.estimatedTokens) || 0;
    const useRootChild = config?.forceRoot || estimatedTokens > threshold;
    const uid = normalizeUserId(userId);

    return await transaction.run(async () => {
        let rootMemoryId: string;
        let childCount = 0;
        let strategy: "single" | "root-child";

        if (!useRootChild) {
            strategy = "single";
            const result = await addHsgMemory(
                extraction.text,
                stringifyJSON([]),
                {
                    ...metadata,
                    ...extraction.metadata,
                    ingestionStrategy: "single",
                    ingestedAt: overrides?.createdAt || now(),
                },
                uid,
                overrides,
            );
            rootMemoryId = result.id;
        } else {
            strategy = "root-child";
            const res = await ingestRootChild(extraction.text, extraction, { ...metadata, sourceUrl: url }, config, userId, overrides);
            rootMemoryId = res.rootId;
            childCount = res.childCount;
            logger.info(`[INGEST] URL: ${estimatedTokens} tokens, split into ${childCount} sections`);
        }

        triggerPostIngestMaintenance();

        return {
            rootMemoryId,
            childCount,
            totalTokens: estimatedTokens,
            strategy,
            extraction: extraction.metadata,
        };
    });
}
