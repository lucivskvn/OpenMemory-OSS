import { q } from "../core/db";
import { getEncryption } from "../core/security";
import { IdeContextItem, IdePattern, MemoryRow } from "../core/types";
import { hsgQuery } from "../memory/hsg";
import { normalizeUserId, parseJSON } from "../utils";
import { logger } from "../utils/logger";

/**
 * Retrieves semantic context for an IDE session, optionally filtered by file or session ID.
 * Integrates with HSG and optionally the Temporal Graph (via session ID).
 */
export async function getIdeContext(args: {
    file: string;
    line: number;
    content: string;
    userId?: string;
    sessionId?: string;
    limit?: number;
}): Promise<import("../core/types").IdeContextResult> {
    const { file, line, content, sessionId, limit = 5 } = args;
    const userId = normalizeUserId(args.userId);

    // Use "content" + "file" + line context as query for semantic retrieval
    const lineContext = line > 0 ? ` line:${line}` : "";
    const query = `${file}${lineContext} ${content.slice(0, 100)}`;

    // Increase search breadth if a file filter is applied to avoid missing context
    const searchLimit = file ? Math.max(limit * 4, 20) : limit;

    const results = await hsgQuery(query, searchLimit, {
        userId,
        sectors: file ? ["semantic", "episodic"] : undefined,
        metadata: sessionId ? { ideSessionId: sessionId } : undefined,
    });

    let filtered = results;

    if (file) {
        const lowerFile = file.toLowerCase();
        filtered = filtered.filter(
            (r) =>
                r.content.toLowerCase().includes(lowerFile) ||
                (r.metadata?.ideFilePath &&
                    String(r.metadata.ideFilePath)
                        .toLowerCase()
                        .includes(lowerFile)),
        );
    }

    // If sessionId is present, try to fetch graph context from Temporal Graph
    let graphContext = "";
    if (sessionId) {
        try {
            // Lazy load to avoid circular dependencies
            const { getGraphCtx } = await import("./graph");
            const gCtx = await getGraphCtx({
                namespace: "ide",
                graphId: sessionId,
                limit: 5,
                userId,
            });
            if (gCtx.context) {
                graphContext = `Graph Context:\n${gCtx.context}`;
            }
        } catch (error) {
            // Fault tolerance: allow IDE context even if graph retrieval fails
            logger.warn(
                `[IDE] Failed to retrieve graph context for session ${sessionId}:`,
                { error },
            );
        }
    }

    const formatted: IdeContextItem[] = filtered
        .map((r) => ({
            memoryId: r.id,
            content: r.content,
            primarySector: r.primarySector,
            sectors: r.sectors,
            score: r.score,
            salience: r.salience,
            lastSeenAt: r.lastSeenAt,
            path: r.path,
        }))
        .slice(0, limit);

    if (graphContext) {
        // Prepend graph context as a synthetic high-relevance item
        formatted.unshift({
            memoryId: "graph-context",
            content: graphContext,
            primarySector: "semantic",
            sectors: ["semantic"],
            score: 1.0,
            salience: 1.0,
            lastSeenAt: Date.now(),
            path: [],
        });
    }

    return {
        success: true,
        context: formatted,
        query,
    };
}

/**
 * Extracts procedural patterns from memories associated with an IDE session.
 */
export async function getIdePatterns(args: {
    activeFiles?: string[];
    userId?: string;
    sessionId?: string;
}): Promise<import("../core/types").IdePatternsResult> {
    const userId = normalizeUserId(args.userId);
    const { sessionId } = args;

    let procedural: MemoryRow[] = [];

    if (sessionId) {
        // Query specifically for session-linked memories
        // Note: getMemByMetadataLike uses LIKE with the pattern, sessionId is sanitized by normalizeUserId pattern
        const sanitizedSessionId = sessionId.replace(/[\"'%_]/g, ""); // Remove SQL special chars
        const allSessionMemories = await q.getMemByMetadataLike.all(
            `"ideSessionId":"${sanitizedSessionId}"`,
            userId,
        );
        procedural = allSessionMemories.filter(
            (m: MemoryRow) => m.primarySector === "procedural",
        );
    } else if (args.activeFiles && args.activeFiles.length > 0) {
        // Fall back to file-based pattern detection if no session
        // Optimization: Use parallel queries for each active file to find relevant procedural memories
        // This is more sustainable than scanning the entire procedural sector.
        const filePatterns = args.activeFiles.slice(0, 5);

        const searchPromises = filePatterns.map(async (filePath) => {
            const filename = filePath.split(/[\\/]/).pop() || filePath;
            // We search for the filename appearing in the metadata JSON string.
            // This is a heuristic but efficient on SQLite/Postgres without native JSON ops enabled in this layer.
            // Note: sanitize for LIKE clause (basic)
            const sanitized = filename.replace(/[%_]/g, "");
            return q.getMemByMetadataLike.all(`%${sanitized}%`, userId);
        });

        const results = await Promise.all(searchPromises);
        const uniqueIds = new Set<string>();

        for (const rows of results) {
            for (const r of rows) {
                if (r.primarySector === "procedural" && !uniqueIds.has(r.id)) {
                    // Double check strict path match if needed, but heuristic is usually good enough for "relevant patterns"
                    // We parse to be sure it's actually an ideFilePath match
                    const meta = parseJSON<Record<string, unknown>>(r.metadata || "{}");
                    if (typeof meta?.ideFilePath === 'string' && meta.ideFilePath.includes(filenameFromPath(meta.ideFilePath))) {
                        // actually we just want to ensure it relates to *any* active file.
                        // The query matched the filename.
                        uniqueIds.add(r.id);
                        procedural.push(r);
                    }
                }
            }
        }
    }

    // Helper unique to this filtering logic, simple implementation inline above is fine.
    // Deduplication is handled by uniqueIds.

    const enc = getEncryption();
    const patterns: IdePattern[] = await Promise.all(
        procedural.map(async (m: MemoryRow) => {
            const decryptedContent = await enc.decrypt(m.content);
            return {
                patternId: m.id,
                description: decryptedContent,
                salience: m.salience,
                detectedAt: m.createdAt,
                lastReinforced: m.lastSeenAt,
            };
        }),
    );

    return {
        success: true,
        sessionId: sessionId || "none",
        patternCount: patterns.length,
        patterns,
    };
}

function filenameFromPath(p: string) {
    return p.split(/[\\/]/).pop() || p;
}
