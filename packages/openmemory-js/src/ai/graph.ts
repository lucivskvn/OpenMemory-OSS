/**
 * Graph-based Memory AI component for OpenMemory.
 * Integrates LangGraph-style agent memory with OpenMemory sectors and vector storage.
 */
import { env } from "../core/cfg";
import { q, vectorStore } from "../core/db";
import { Memory } from "../core/memory";
import type {
    LgConfig,
    LgContextResult,
    LgmContextRequest,
    LgmReflectionRequest,
    LgmRetrieveRequest,
    LgmStoreRequest,
    LgNodeContext,
    LgReflectResult,
    LgRetrieveResult,
    LgStoreResult,
    MemoryItem,
    MemoryRow,
    SectorType,
} from "../core/types";
import { addHsgMemory, hsgQuery } from "../memory/hsg";
import { AppError } from "../server/errors";
import { normalizeUserId, now, stringifyJSON } from "../utils";
import { logger } from "../utils/logger";

/**
 * Graph-specific memory extension.
 * Represents a memory item that is bound to a specific node in a LangGraph execution graph.
 */
export interface GraphMemoryItem extends MemoryItem {
    /** The LangGraph node name (e.g., 'plan', 'reflect') */
    node: string;
    /** The mapped sectors for this memory */
    sectors: string[];
    /** Similarity score if retrieved via vector search */
    score?: number;
    /** Graph traversal path if applicable */
    path?: string[];
}

/**
 * Maps LangGraph node types to OpenMemory sectors.
 */
export const nodeSectorMap: Record<string, SectorType> = {
    observe: "episodic",
    plan: "semantic",
    reflect: "reflective",
    act: "procedural",
    emotion: "emotional",
};

const defaultSector: SectorType = "semantic";
const summaryLineLimit = 160;

const trunc = (txt: string, max = 320) =>
    txt.length <= max ? txt : `${txt.slice(0, max).trimEnd()}...`;

const parseJsonSafe = <T>(val: string | null | undefined, fb: T): T => {
    if (!val) return fb;
    try {
        const parsed = JSON.parse(val);
        return parsed as T;
    } catch {
        return fb;
    }
};

const resolveSector = (node: string): SectorType =>
    nodeSectorMap[node.toLowerCase()] ?? defaultSector;

const resolveNs = (ns?: string) => ns || env.lgNamespace;

const buildTags = (
    tags: string[] | undefined,
    node: string,
    ns: string,
    gid?: string,
) => {
    const ts = new Set<string>(tags || []);
    ts.add(`lgm:node:${node.toLowerCase()}`);
    ts.add(`lgm:namespace:${ns}`);
    if (gid) ts.add(`lgm:graph:${gid}`);
    return Array.from(ts);
};

interface LgmMetadata extends Record<string, unknown> {
    lgm?: {
        node?: string;
        sector?: string;
        namespace?: string;
        graphId?: string | null;
        storedAt?: number;
        mode?: string;
        sourceMemory?: string;
        sourceNode?: string;
        [key: string]: unknown;
    };
}

const buildMeta = (
    p: LgmStoreRequest,
    sec: SectorType,
    ns: string,
    ext?: Record<string, unknown>,
): LgmMetadata => {
    const base = { ...(p.metadata || {}) } as LgmMetadata;
    const exLgm = base.lgm || {};

    base.lgm = {
        ...exLgm,
        node: p.node.toLowerCase(),
        sector: sec,
        namespace: ns,
        graphId: p.graphId ?? null,
        storedAt: now(),
        mode: "langgraph",
        ...ext,
    };
    base.sector = sec;
    return base;
};

const matchesNs = (meta: Record<string, unknown>, ns: string, gid?: string) => {
    const lgm = (meta as LgmMetadata).lgm;
    if (!lgm) return false;
    if (lgm.namespace !== ns) return false;
    if (gid && lgm.graphId !== gid) return false;
    return true;
};

const hydrateMemRow = (
    row: MemoryRow,
    metadata: Record<string, unknown>,
    incMeta: boolean,
    vectors: { sector: string; vector: number[]; dim: number }[],
    score?: number,
    path?: string[],
    preParsedTags?: string[],
): GraphMemoryItem => {
    const tags = preParsedTags || parseJsonSafe<string[]>(row.tags, []);
    const secs = vectors.length > 0 ? vectors.map((v) => v.sector) : [row.primarySector];
    const metaTyped = metadata as LgmMetadata;
    const node = metaTyped.lgm?.node || row.primarySector;

    const baseItem: MemoryItem = {
        id: row.id,
        content: row.content || "",
        primarySector: row.primarySector,
        tags,
        createdAt: row.createdAt || 0,
        updatedAt: row.updatedAt || 0,
        lastSeenAt: row.lastSeenAt || 0,
        salience: row.salience || 0.5,
        decayLambda: row.decayLambda || 0.01,
        version: row.version || 1,
        userId: row.userId || null,
        metadata: incMeta ? metadata : {},
        segment: row.segment || 0,
        simhash: row.simhash || null,
        generatedSummary: row.generatedSummary || null,
    };

    const graphItem: GraphMemoryItem = {
        ...baseItem,
        node,
        sectors: secs,
    };

    if (typeof score === "number") graphItem.score = score;
    if (path) graphItem.path = path;

    return graphItem;
};

const buildReflContent = (p: LgmStoreRequest, ns: string) => {
    const parts = [
        `LangGraph reflection for node "${p.node}"`,
        `namespace=${ns}`,
    ];
    if (p.graphId) parts.push(`graph=${p.graphId}`);
    return `${parts.join(" | ")}\n\n${trunc(p.content || "", 480)}`;
};

const createAutoRefl = async (
    p: LgmStoreRequest,
    stored: { id: string; namespace: string; graphId: string | null },
) => {
    const reflTags = buildTags(
        [`lgm:auto:reflection`, `lgm:source:${stored.id}`],
        "reflect",
        stored.namespace,
        stored.graphId ?? undefined,
    );
    const reflMeta = {
        lgm: {
            node: "reflect",
            sector: "reflective",
            namespace: stored.namespace,
            graphId: stored.graphId,
            storedAt: now(),
            mode: "langgraph",
            sourceMemory: stored.id,
            sourceNode: p.node.toLowerCase(),
        },
        sector: "reflective",
    };
    const res = await addHsgMemory(
        buildReflContent(p, stored.namespace),
        stringifyJSON(reflTags),
        reflMeta,
        normalizeUserId(p.userId),
    );
    return {
        id: res.id,
        node: "reflect",
        primarySector: res.primarySector,
        sectors: res.sectors,
        namespace: stored.namespace,
        graphId: stored.graphId,
        tags: reflTags,
        chunks: res.chunks ?? 1,
        metadata: reflMeta,
    };
};

/**
 * Stores a memory associated with a specific LangGraph node.
 * Automatically handles sector resolution, tagging, and elective reflection.
 * 
 * **Consistency**: Enforces `lgm:node` and `lgm:namespace` tagging.
 * **Sustainability**: Electively triggers reflection for high-value nodes.
 *
 * @param p - The storage request containing content, node name, and optional graph context.
 * @returns The result including the memory ID and any auto-generated reflection ID.
 * @throws {AppError} If node or content is missing.
 */
export async function storeNodeMem(
    p: LgmStoreRequest,
): Promise<LgStoreResult & { reflectionId?: string }> {
    if (!p?.node) throw new AppError(400, "BAD_REQUEST", "node is required");
    if (!p?.content && !p?.memoryId)
        throw new AppError(400, "BAD_REQUEST", "content or memoryId is required");

    const ns = resolveNs(p.namespace);
    const node = p.node.toLowerCase();
    const sec = resolveSector(node);
    const tagList = buildTags(p.tags, node, ns, p.graphId);
    const meta = buildMeta(p, sec, ns);
    const userId = normalizeUserId(p.userId);

    let res: {
        id: string;
        primarySector: string;
        sectors: string[];
        createdAt: number;
        userId: string | null;
        content?: string;
    };

    if (p.memoryId) {
        // Linking an existing memory
        const mem = new Memory(userId || undefined);
        const existing = await mem.get(p.memoryId);
        if (!existing) {
            throw new AppError(404, "NOT_FOUND", `Memory ${p.memoryId} not found`);
        }

        // Update content if provided
        const updatedContent = p.content !== undefined ? p.content : existing.content;

        // Merge tags and metadata
        const mergedTags = Array.from(new Set([...existing.tags, ...tagList]));
        const mergedMeta = { ...existing.metadata, ...meta };

        const updateSuccess = await mem.update(p.memoryId, updatedContent, mergedTags, mergedMeta);
        if (!updateSuccess) {
            throw new AppError(500, "INTERNAL_ERROR", `Failed to update memory ${p.memoryId} for linking`);
        }

        res = {
            id: p.memoryId,
            primarySector: existing.primarySector,
            sectors: (existing.sectors as string[]) || [],
            createdAt: existing.createdAt,
            userId: existing.userId || null,
            content: updatedContent,
        };
    } else {
        // Creating a new memory
        const addRes = await addHsgMemory(
            p.content!,
            stringifyJSON(tagList),
            meta,
            userId,
        );
        res = {
            id: addRes.id,
            primarySector: addRes.primarySector,
            sectors: addRes.sectors,
            createdAt: addRes.createdAt,
            userId: addRes.userId || null,
            content: addRes.content,
        };
    }

    const stored: GraphMemoryItem & { namespace: string; graphId: string | null } = {
        id: res.id,
        node,
        primarySector: res.primarySector,
        sectors: res.sectors,
        namespace: ns,
        graphId: p.graphId || null,
        tags: tagList,
        metadata: meta,
        content: res.content || p.content || "",
        createdAt: res.createdAt,
        updatedAt: now(),
        lastSeenAt: now(),
        userId: res.userId,
        salience: (meta.salience as number) || 0.5,
        decayLambda: (meta.decayLambda as number) || 0.01,
        version: 1,
        segment: 0,
        simhash: null,
        generatedSummary: null,
    };

    const reflSet = p.reflective ?? env.lgReflective;
    const refl =
        reflSet && node !== "reflect" ? await createAutoRefl(p, stored) : null;

    return {
        success: true,
        memoryId: res.id,
        node,
        memory: stored,
        reflectionId: refl?.id,
    };
}

/**
 * Retrieves memories for a LangGraph node, supporting both vector search and chronological listing.
 * Optimized to skip vector hydration for high-volume nodes like 'observe'.
 * 
 * **Performance Note**: Skips vector lookups for `observe` node unless explicitly requested
 * to reduce latency in high-throughput loops.
 *
 * @param p - Retrieval parameters (node, query, limit, etc.)
 * @returns A list of graph memory items.
 */
export async function retrieveNodeMems(
    p: LgmRetrieveRequest,
): Promise<LgRetrieveResult & { items: GraphMemoryItem[] }> {
    if (!p?.node) throw new AppError(400, "BAD_REQUEST", "node is required");

    const ns = resolveNs(p.namespace);
    const node = p.node.toLowerCase();
    const sec = resolveSector(node);
    const lim = p.limit || env.lgMaxContext;
    const incMeta = p.includeMetadata ?? false;
    const gid = p.graphId;
    const userId = normalizeUserId(p.userId);
    const items: GraphMemoryItem[] = [];

    // Store pre-parsed data from matches to avoid double serialization
    let candidateRows: {
        row: MemoryRow;
        score?: number;
        path?: string[];
        preParsedTags?: string[];
        preParsedMeta?: Record<string, unknown>;
    }[] = [];

    if (p.query) {
        const matches = await hsgQuery(p.query, lim * 2, {
            sectors: [sec],
            userId,
        });

        // Optimization: Use enriched results directly without re-fetching
        for (const match of matches) {
            const row: MemoryRow = {
                id: match.id,
                content: match.content,
                primarySector: match.primarySector,
                tags: null, // Defer serialization, use preParsedTags
                metadata: null, // Defer serialization, use preParsedMeta
                userId: match.userId ?? null,
                createdAt: match.createdAt,
                updatedAt: match.updatedAt || 0,
                lastSeenAt: match.lastSeenAt,
                salience: match.salience,
                decayLambda: match.decayLambda || 0.01,
                version: match.version || 1,
                segment: match.segment || 0,
                simhash: match.simhash || null,
                generatedSummary: match.generatedSummary || null,
                // These are not returned by hsgQuery but not needed for basic retrieval
                meanDim: 0,
                meanVec: null,
                compressedVec: null,
                feedbackScore: 0,
            };
            candidateRows.push({
                row,
                score: match.score,
                path: match.path,
                preParsedTags: match.tags || [],
                preParsedMeta: match.metadata || {},
            });
        }
    } else {
        const nsTag = `lgm:namespace:${ns}`;
        const raw_rows = (await q.allMemBySectorAndTag.all(
            sec,
            nsTag,
            lim * 4,
            0,
            userId,
        )) as MemoryRow[];
        candidateRows = raw_rows.map((r) => ({ row: r }));
    }

    const filteredRows: {
        row: MemoryRow;
        score?: number;
        path?: string[];
        preParsedTags?: string[];
        preParsedMeta?: Record<string, unknown>;
    }[] = [];
    for (const cand of candidateRows) {
        // Use pre-parsed meta if available, otherwise parse from row
        const metadata =
            cand.preParsedMeta ||
            parseJsonSafe<Record<string, unknown>>(cand.row.metadata, {});

        if (!matchesNs(metadata, ns, gid)) continue;

        // Ensure meta is attached to row for consistency if it was deferred
        if (!cand.row.metadata && cand.preParsedMeta) {
            cand.row.metadata = JSON.stringify(cand.preParsedMeta);
        }

        filteredRows.push(cand);
        if (filteredRows.length >= lim) break;
    }

    // Optimization: Skip vector fetch for "observe" node as it's rarely used for retrieval vectors
    // and "observe" is high volume.
    const isObserveNode = node === "observe";
    const vectorMap = new Map<
        string,
        { sector: string; vector: number[]; dim: number }[]
    >();

    if (filteredRows.length > 0 && !isObserveNode) {
        const allIds = filteredRows.map((r) => r.row.id);
        const allVecs = await vectorStore.getVectorsByIds(allIds, userId);

        for (const v of allVecs) {
            if (!vectorMap.has(v.id)) {
                vectorMap.set(v.id, []);
            }
            vectorMap
                .get(v.id)
                ?.push({ sector: v.sector, vector: v.vector, dim: v.dim });
        }
    }

    for (const cand of filteredRows) {
        const metadata =
            cand.preParsedMeta ||
            parseJsonSafe<Record<string, unknown>>(cand.row.metadata, {});
        const vectors = vectorMap.get(cand.row.id) || [];
        const hyd = hydrateMemRow(
            cand.row,
            metadata,
            incMeta,
            vectors,
            cand.score,
            cand.path,
            cand.preParsedTags,
        );
        items.push(hyd);
    }

    if (!p.query) {
        items.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }

    return {
        success: true,
        memories: items, // Complies with LgRetrieveResult
        items, // Keep as backward compatibility for internal consumers if any
    };
}

/**
 * Collects context from across all LangGraph nodes for the current graph execution thread.
 * Aggregates summaries from 'observe', 'plan', 'reflect', 'act', etc.
 *
 * @param p - Context request parameters (namespace, graphId, limit).
 * @returns A synthesized string of context and structured node references.
 */
export async function getGraphCtx(
    p: LgmContextRequest,
): Promise<LgContextResult & { nodes: LgNodeContext[] }> {
    const ns = resolveNs(p.namespace);
    const gid = p.graphId;
    const lim = p.limit || env.lgMaxContext;
    const nodes = Object.keys(nodeSectorMap);
    const perNodeLim = Math.max(1, Math.floor(lim / nodes.length) || 1);

    const resListResults = await Promise.allSettled(
        nodes.map((node) =>
            retrieveNodeMems({
                node,
                namespace: ns,
                graphId: gid,
                limit: perNodeLim,
                includeMetadata: true,
                userId: normalizeUserId(p.userId),
            }),
        ),
    );

    const nodeCtxs: LgNodeContext[] = resListResults
        .filter((r) => r.status === "fulfilled")
        .map(
            (r) =>
                (
                    r as PromiseFulfilledResult<
                        Awaited<ReturnType<typeof retrieveNodeMems>>
                    >
                ).value,
        )
        .map((res, i) => ({
            node: nodes[i],
            items: res.items,
        }));

    const failures = resListResults.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        logger.warn(
            `[LGM] Failed to retrieve context for ${failures.length} nodes in namespace ${ns}`,
        );
    }

    const flat = nodeCtxs.flatMap((e) =>
        e.items.map((i) => ({
            node: e.node,
            content: trunc(i.content, summaryLineLimit),
        })),
    );

    const summ = flat.length
        ? flat
            .slice(0, lim)
            .map((ln) => `- [${ln.node}] ${ln.content}`)
            .join("\n")
        : "";

    return {
        success: true,
        context: summ,
        sources: Array.from(new Set(flat.map((f) => f.node))),
        nodes: nodeCtxs,
    };
}

/**
 * Get linear history of a graph execution thread.
 */
export async function getThreadHistory(p: LgmRetrieveRequest) {
    const ns = resolveNs(p.namespace);
    if (!p.graphId)
        throw new AppError(400, "BAD_REQUEST", "graphId required for history");

    const nodes = Object.keys(nodeSectorMap);
    const resListResults = await Promise.allSettled(
        nodes.map((node) =>
            retrieveNodeMems({
                node,
                namespace: ns,
                graphId: p.graphId,
                userId: normalizeUserId(p.userId),
                limit: 100,
            }),
        ),
    );

    const allItems = resListResults
        .filter((r) => r.status === "fulfilled")
        .flatMap(
            (r) =>
                (
                    r as PromiseFulfilledResult<
                        Awaited<ReturnType<typeof retrieveNodeMems>>
                    >
                ).value.memories as GraphMemoryItem[],
        );

    const failures = resListResults.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
        logger.warn(
            `[LGM] Failed to retrieve history for ${failures.length} nodes in graph ${p.graphId}`,
        );
    }

    allItems.sort((a, b) => a.createdAt - b.createdAt);

    return {
        namespace: ns,
        graphId: p.graphId,
        userId: normalizeUserId(p.userId) ?? null,
        count: allItems.length,
        history: allItems.map((i) => ({
            id: i.id,
            node: i.node,
            content: i.content,
            timestamp: new Date(i.createdAt).toISOString(),
            metadata: i.metadata,
        })),
    };
}

const buildCtxRefl = async (
    ns: string,
    gid?: string,
    userId?: string | null,
) => {
    const ctx = await getGraphCtx({
        namespace: ns,
        graphId: gid,
        limit: env.lgMaxContext,
        userId: normalizeUserId(userId),
    });

    if (!ctx.context) return null;

    const hdr = `Reflection synthesized from LangGraph context (namespace=${ns}${gid ? `, graph=${gid}` : ""})`;
    return `${hdr}\n\n${ctx.context}`;
};

/**
 * Manually creates a reflection memory entry.
 */
export async function createRefl(
    p: LgmReflectionRequest,
): Promise<LgReflectResult> {
    const ns = resolveNs(p.namespace);
    const node = (p.node || "reflect").toLowerCase();
    const baseContent =
        p.content || (await buildCtxRefl(ns, p.graphId, p.userId));

    if (!baseContent)
        throw new AppError(
            400,
            "BAD_REQUEST",
            "reflection content could not be derived",
        );

    const tags = [
        `lgm:manual:reflection`,
        ...(p.contextIds?.map((id) => `lgm:context:${id}`) || []),
    ];
    const meta: Record<string, unknown> = {
        lgmContextIds: p.contextIds || [],
    };

    const res = await storeNodeMem({
        node,
        content: baseContent,
        namespace: ns,
        graphId: p.graphId,
        tags,
        metadata: meta,
        reflective: false,
        userId: p.userId,
    });

    return {
        success: true,
        reflectionId: res.memoryId,
        insights: [baseContent.slice(0, 100)], // Basic insight extraction for now
    };
}

/**
 * Returns the current LangGraph configuration.
 */
export const getLgCfg = (): LgConfig => ({
    success: true,
    config: {
        nodes: Object.keys(nodeSectorMap),
        edges: [
            { source: "observe", target: "plan" },
            { source: "plan", target: "act" },
            { source: "act", target: "reflect" },
            { source: "reflect", target: "plan" },
            { source: "observe", target: "emotion" },
        ],
    },
});
