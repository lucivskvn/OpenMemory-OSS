/**
 * @file Ingestion Operations for OpenMemory.
 * Handles document extraction, summarization, chunking, and hierarchical storage.
 */
import { get_generator } from "../ai/adapters";
import { env } from "../core/cfg";
import { q, transaction } from "../core/db";
import { triggerMaintenance } from "../core/scheduler";
import { IngestionConfig, IngestionResult, ExtractionResult } from "../core/types";
import { addHsgMemories, addHsgMemory } from "../memory/hsg";
import { normalizeUserId, now, stringifyJSON } from "../utils";
import { splitText } from "../utils/chunking";
import { logger } from "../utils/logger";
import { compressionEngine } from "./compress";
import { extractText, extractURL } from "./extract";

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
    metadata: Record<string, unknown> | undefined,
    userId: string | null | undefined,
    config: IngestionConfig | undefined,
    overrides?: { id?: string; createdAt?: number; tags?: string[] },
) {
    const uid = normalizeUserId(userId);
    let summarySnippet = "";

    // Strategy 1: Heuristic/Syntactic Compression (Extreme Token Savings)
    const useFast = config?.fastSummarize ?? true;
    if (useFast) {
        const compressed = compressionEngine.compress(text, "semantic", uid);
        summarySnippet = compressed?.comp || "";
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
                // Sanitize error to avoid leaking prompt/content in logs
                const err = e instanceof Error ? e.message : String(e);
                logger.warn(
                    `[INGEST] AI summarization failed, falling back to compression: ${err}`,
                );
                const fallback = compressionEngine.compress(text, "semantic", uid);
                summarySnippet = (fallback?.comp || "").slice(0, 800) + "...";
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
        text.length / (config?.secSz || env.ingestSectionSize),
    );
    const content = `[Document: ${contentType}]\n\n${summarySnippet}\n\n[Full content split across ${sectionCount} sections]`;

    const res = await addHsgMemory(
        content,
        overrides?.tags || [], // use passed tags or empty array
        {
            ...metadata,
            ...extraction.metadata,
            isRoot: true,
            ingestionStrategy: "root-child",
            sector: (metadata?.sector as string) || "reflective",
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
    overrides?: { id?: string; createdAt?: number; tags?: string[] },
): Promise<{ rootId: string; childCount: number }> {
    const uid = normalizeUserId(userId);
    const rootId = await createRootMemory(text, extraction, metadata, userId, config, overrides);

    const size = config?.secSz || env.ingestSectionSize;
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
 * Shared logic for processing the storage strategy (Single vs Root-Child).
 */
async function processIngestionStrategy(
    uid: string | null | undefined,
    extraction: ExtractionResult,
    metadata: Record<string, unknown>,
    config: IngestionConfig | undefined,
    tags: string[],
    overrides?: { id?: string; createdAt?: number; tags?: string[] },
    logPrefix = "[INGEST]"
) {
    const threshold = config?.lgThresh || env.ingestLargeThreshold;
    const estimatedTokens = Number(extraction.metadata.estimatedTokens) || 0;
    const useRootChild = config?.forceRoot || estimatedTokens > threshold;

    let rootMemoryId: string;
    let childCount = 0;
    let strategy: "single" | "root-child";

    if (!useRootChild) {
        strategy = "single";
        const result = await addHsgMemory(
            extraction.text,
            tags,
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
        // For root-child, the root ID is the one overridden if provided
        const res = await ingestRootChild(extraction.text, extraction, metadata, config, uid, overrides);
        rootMemoryId = res.rootId;
        childCount = res.childCount;
        logger.info(`${logPrefix} ${estimatedTokens} tokens, split into ${childCount} sections`);
    }

    triggerPostIngestMaintenance();

    return {
        rootMemoryId,
        childCount,
        totalTokens: estimatedTokens,
        strategy,
        extraction: extraction.metadata,
    };
}

/**
 * Ingests a raw document (text or buffer), optionally splitting it into hierarchical chunks.
 */
export async function ingestDocument(
    contentType: string,
    data: string | Buffer | Uint8Array,
    opts?: {
        metadata?: Record<string, unknown>;
        tags?: string[];
        config?: IngestionConfig;
        userId?: string | null;
        id?: string;
        createdAt?: number;
    },
): Promise<IngestionResult> {
    const { metadata, tags, config, userId, ...overrides } = opts || {};
    const uid = normalizeUserId(userId);

    const extraction = await extractText(contentType, data, config);
    const { text } = extraction;
    if (!text || text.trim().length === 0) {
        throw new Error("Ingestion Failed: Extracted content is empty");
    }

    return await transaction.run(async () => {
        return processIngestionStrategy(
            uid,
            extraction,
            metadata || {},
            config,
            tags || [],
            { ...overrides, tags }, // Pass tags in overrides for root creation
            `[INGEST] Document:`,
        );
    });
}

/**
 * Ingests content from a URL by extracting text and metadata.
 */
export async function ingestUrl(
    url: string,
    opts?: {
        metadata?: Record<string, unknown>;
        tags?: string[];
        config?: IngestionConfig;
        userId?: string | null;
        id?: string;
        createdAt?: number;
    },
): Promise<IngestionResult> {
    const { metadata, tags, config, userId, ...overrides } = opts || {};
    const extraction = await extractURL(url, config);
    const uid = normalizeUserId(userId ?? null);

    return await transaction.run(async () => {
        return processIngestionStrategy(
            uid,
            extraction,
            { ...metadata, sourceUrl: url },
            config,
            tags || [],
            { ...overrides, tags },
            `[INGEST] URL:`,
        );
    });
}

