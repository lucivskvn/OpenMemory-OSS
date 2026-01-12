import { z } from "zod";

import { q } from "../../core/db";
import { eventBus, EVENTS } from "../../core/events";
import { addHsgMemory } from "../../memory/hsg";
import { updateUserSummary } from "../../memory/user_summary";
import { parseJSON, stringifyJSON } from "../../utils";
import { logger } from "../../utils/logger";
import { sendError } from "../errors";
import { validateBody, validateParams } from "../middleware/validate";
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

const IdeEventSchema = z.object({
    eventType: z.string().min(1),
    filePath: z.string().optional().default("unknown"),
    content: z.string().max(1024 * 1024).optional().default(""), // Max 1MB
    sessionId: z.string().optional().default("default"),
    language: z.string().optional(),
    userId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
});
type IdeEvent = z.infer<typeof IdeEventSchema>;

const IdeContextSchema = z.object({
    query: z.string().min(1),
    k: z
        .number()
        .optional()
        .or(z.string().transform((v) => parseInt(v)))
        .default(5),
    sessionId: z.string().optional(),
    filePath: z.string().optional(),
    userId: z.string().optional(),
});
type IdeContext = z.infer<typeof IdeContextSchema>;

const IdeSessionStartSchema = z.object({
    projectName: z.string().optional().default("unknown"),
    ideName: z.string().optional().default("unknown"),
    userId: z.string().optional(), // Client-provided user/machine ID
});
type IdeSessionStart = z.infer<typeof IdeSessionStartSchema>;

const IdeSessionEndSchema = z.object({
    sessionId: z.string().min(1),
});
type IdeSessionEnd = z.infer<typeof IdeSessionEndSchema>;

const SessionIdParams = z.object({
    sessionId: z.string().min(1),
});
type SessionIdParam = z.infer<typeof SessionIdParams>;

/**
 * IDE Integration Routes.
 * Provides endpoints for session management, event tracking, and context retrieval.
 * Security: Admin-only overrides, strict user isolation for standard users.
 */
export function ideRoutes(app: ServerApp) {
    /**
     * POST /api/ide/events
     * Records an IDE event (open, save, close, etc.) as a memory.
     * Updates User Summary to reflect recent activity.
     */
    app.post(
        "/api/ide/events",
        validateBody(IdeEventSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const {
                    eventType,
                    filePath,
                    content,
                    sessionId,
                    language,
                    userId: bodyUserId,
                    metadata,
                } = req.body as IdeEvent;

                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let effectiveUserId = req.user?.id;

                if (isAdmin && bodyUserId) {
                    effectiveUserId = bodyUserId;
                }
                // If not admin, effectiveUserId remains req.user.id (or undefined/null if anon auth logic allows)
                // Assuming auth middleware handles ensuring req.user is set if required.

                let memoryContent = "";
                if (eventType === "open") {
                    memoryContent = `Opened file: ${filePath}`;
                } else if (eventType === "save") {
                    memoryContent = content
                        ? `Saved file: ${filePath}\n\n${content}`
                        : `Saved file: ${filePath}`;
                } else if (eventType === "close") {
                    memoryContent = `Closed file: ${filePath}`;
                } else {
                    memoryContent =
                        `[${eventType}] ${filePath}\n${content}`.trim();
                }

                // Extract sectorHints from metadata for classification guidance
                const sectorHints = metadata?.sectorHints as
                    | string[]
                    | undefined;

                const fullMetadata = {
                    ...metadata,
                    ideEventType: eventType,
                    ideFilePath: filePath,
                    ideSessionId: sessionId,
                    ideLanguage: language,
                    ideTimestamp: Date.now(),
                    ideMode: true,
                };

                const result = await addHsgMemory(
                    memoryContent,
                    sectorHints?.[0] || null,
                    fullMetadata,
                    effectiveUserId,
                );

                if (effectiveUserId) {
                    updateUserSummary(effectiveUserId).catch((err) =>
                        logger.error("[IDE] Failed to update user summary:", {
                            error: err,
                        }),
                    );
                }

                res.json({
                    success: true,
                    memoryId: result.id,
                    primarySector: result.primarySector,
                    sectors: result.sectors,
                });
            } catch (err: unknown) {
                logger.error("[IDE] Error storing IDE event:", { error: err });
                sendError(res, err);
            }
        },
    );

    /**
     * POST /api/ide/context
     * Retrieves relevant context for the current IDE state.
     * Uses `getIdeContext` which blends semantic search with recent activity.
     */
    app.post(
        "/api/ide/context",
        validateBody(IdeContextSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { query, k, sessionId, filePath, userId: bodyUserId } =
                    req.body as IdeContext;

                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = req.user?.id;
                if (isAdmin && bodyUserId) userId = bodyUserId;

                const { getIdeContext } = await import("../../ai/ide");
                const result = await getIdeContext({
                    file: filePath || "",
                    line: 0,
                    content: query, // Use query as content hint
                    userId,
                    sessionId,
                    limit: k,
                });

                res.json({
                    success: true,
                    context: result.context,
                    total: result.context.length,
                    query: query,
                });
            } catch (err: unknown) {
                logger.error("[IDE] Error retrieving IDE context:", {
                    error: err,
                });
                sendError(res, err);
            }
        },
    );

    /**
     * POST /api/ide/session/start
     * Signals the start of a coding session.
     */
    app.post(
        "/api/ide/session/start",
        validateBody(IdeSessionStartSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const {
                    projectName,
                    ideName,
                    userId: clientUserId,
                } = req.body as IdeSessionStart;

                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = req.user?.id;
                // Session start: allow client ID overrides if Admin, OR if anon mode
                if (isAdmin && clientUserId) userId = clientUserId;

                const randomBytes = new Uint8Array(7);
                globalThis.crypto.getRandomValues(randomBytes);
                const hex = Buffer.from(randomBytes).toString("hex");
                const sessionId = `session_${Date.now()}_${hex}`;
                const nowTs = Date.now();

                const content = `Session started: ${clientUserId || userId || "public"} in ${projectName} using ${ideName}`;

                const metadata = {
                    ideSessionId: sessionId,
                    ideUserId: userId, // The authenticated user (API Key holder)
                    clientUserId: clientUserId, // The device/client-reported ID
                    ideProjectName: projectName,
                    ideName: ideName,
                    sessionStartTime: nowTs,
                    sessionType: "ide_session",
                    ideMode: true,
                };

                const result = await addHsgMemory(
                    content,
                    null,
                    metadata,
                    userId,
                );

                if (userId) {
                    updateUserSummary(userId).catch((err) =>
                        logger.error(
                            "[IDE] Failed to update summary on session start:",
                            { error: err },
                        ),
                    );
                }

                eventBus.emit(EVENTS.IDE_SESSION_UPDATE, {
                    sessionId,
                    status: "started",
                    projectName,
                    userId,
                });

                res.json({
                    success: true,
                    sessionId: sessionId,
                    memoryId: result.id,
                    startedAt: nowTs,
                    userId: userId,
                    projectName: projectName,
                    ideName: ideName,
                });
            } catch (err: unknown) {
                logger.error("[IDE] Error starting IDE session:", {
                    error: err,
                });
                sendError(res, err);
            }
        },
    );

    /**
     * POST /api/ide/session/end
     * Signals the end of a coding session and generates a summary.
     */
    app.post(
        "/api/ide/session/end",
        validateBody(IdeSessionEndSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { sessionId } = req.body as IdeSessionEnd;
                const userId = req.user?.id;
                const nowTs = Date.now();
                // Use standardized metadata field for search
                const sessionMemories = await q.getMemByMetadataLike.all(
                    `"ideSessionId":"${sessionId}"`,
                    userId,
                );

                const totalEvents = sessionMemories.length;
                const sectors: Record<string, number> = {};
                const files = new Set<string>();

                for (const m of sessionMemories) {
                    sectors[m.primarySector] =
                        (sectors[m.primarySector] || 0) + 1;
                    try {
                        const meta = parseJSON<Record<string, unknown>>(m.metadata || "{}");
                        if (
                            meta &&
                            typeof meta.ideFilePath === "string" &&
                            meta.ideFilePath !== "unknown"
                        ) {
                            files.add(meta.ideFilePath);
                        }
                    } catch { }
                }

                const summary = `Session ${sessionId} ended. Events: ${totalEvents}, Files: ${files.size}, Sectors: ${stringifyJSON(sectors)}`;

                const metadata = {
                    ideSessionId: sessionId,
                    sessionEndTime: nowTs,
                    sessionType: "ide_session_end",
                    totalEvents: totalEvents,
                    sectorsDistribution: sectors,
                    filesTouched: Array.from(files),
                    ideMode: true,
                };

                const result = await addHsgMemory(
                    summary,
                    undefined,
                    metadata,
                    userId,
                );

                if (userId) {
                    updateUserSummary(userId).catch((err) =>
                        logger.error(
                            "[IDE] Failed to update summary on session end:",
                            err,
                        ),
                    );
                }

                eventBus.emit(EVENTS.IDE_SESSION_UPDATE, {
                    sessionId,
                    status: "ended",
                    summary,
                    userId,
                });

                res.json({
                    success: true,
                    sessionId: sessionId,
                    endedAt: nowTs,
                    summaryMemoryId: result.id,
                    statistics: {
                        totalEvents: totalEvents,
                        sectors: sectors,
                        uniqueFiles: files.size,
                        files: Array.from(files),
                    },
                });
            } catch (err: unknown) {
                logger.error("[IDE] Error ending IDE session:", { error: err });
                sendError(res, err);
            }
        },
    );

    /**
     * GET /api/ide/patterns/:sessionId
     * Detects coding patterns from the specified session.
     * Triggers an `IDE_SUGGESTION` event if patterns are found.
     */
    app.get(
        "/api/ide/patterns/:sessionId",
        validateParams(SessionIdParams),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { sessionId } = req.params as SessionIdParam;

                const userId = req.user?.id;
                const { getIdePatterns } = await import("../../ai/ide");
                const result = await getIdePatterns({
                    activeFiles: [],
                    userId,
                    sessionId,
                });

                if (result.patterns.length > 0) {
                    eventBus.emit(EVENTS.IDE_SUGGESTION, {
                        sessionId,
                        count: result.patterns.length,
                        topPattern: result.patterns[0],
                        userId,
                    });
                }

                res.json({
                    success: true,
                    sessionId: sessionId,
                    patternCount: result.patterns.length,
                    patterns: result.patterns,
                });
            } catch (err: unknown) {
                logger.error("[IDE] Error detecting patterns:", { error: err });
                sendError(res, err);
            }
        },
    );
}
