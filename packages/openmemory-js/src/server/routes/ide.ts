import { Elysia } from "elysia";
import { z } from "zod";

import { q } from "../../core/db";
import { eventBus, EVENTS } from "../../core/events";
import { addHsgMemory } from "../../memory/hsg";
import { updateUserSummary } from "../../memory/user_summary";
import { parseJSON, stringifyJSON } from "../../utils";
import { env } from "../../core/cfg";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";
import { verifyUserAccess, getUser, getEffectiveUserId } from "../middleware/auth";
import type { UserContext } from "../middleware/auth";
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
 */
export const ideRoutes = (app: Elysia) => app.group("/api/ide", (app) => {
    return app
        /**
         * POST /api/ide/events
         * Records an IDE event (open, save, close, etc.) as a memory.
         * Updates User Summary to reflect recent activity.
         */
        .post("/events", async ({ body, ...ctx }) => {
            const data = IdeEventSchema.parse(body);
            const user = getUser(ctx);
            // Scope check done globally or per route? The original had auth(["memory:write"])
            // We can check scopes here
            if (!user?.scopes.includes("memory:write") && !user?.scopes.includes("admin:all")) {
                throw new AppError(403, "FORBIDDEN", "Missing scope: memory:write");
            }

            const {
                eventType,
                filePath,
                content,
                sessionId,
                language,
                userId: bodyUserId,
                metadata,
            } = data;

            const effectiveUserId = getEffectiveUserId(user, bodyUserId);

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

            return {
                success: true,
                memoryId: result.id,
                primarySector: result.primarySector,
                sectors: result.sectors,
            };
        })

        /**
         * POST /api/ide/context
         * Retrieves relevant context for the current IDE state.
         */
        .post("/context", async ({ body, ...ctx }) => {
            const data = IdeContextSchema.parse(body);
            const user = getUser(ctx);
            if (!user?.scopes.includes("memory:read") && !user?.scopes.includes("admin:all")) {
                throw new AppError(403, "FORBIDDEN", "Missing scope: memory:read");
            }

            const { query, k, sessionId, filePath, userId: bodyUserId } = data;

            const isAdmin = user?.scopes.includes("admin:all");
            let userId = user?.id;
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

            return {
                success: true,
                context: result.context,
                total: result.context.length,
                query: query,
            };
        })

        /**
         * POST /api/ide/session/start
         * Signals the start of a coding session.
         */
        .post("/session/start", async ({ body, ...ctx }) => {
            const data = IdeSessionStartSchema.parse(body);
            const user = getUser(ctx);
            if (!user?.scopes.includes("memory:write") && !user?.scopes.includes("admin:all")) {
                throw new AppError(403, "FORBIDDEN", "Missing scope: memory:write");
            }

            const {
                projectName,
                ideName,
                userId: clientUserId,
            } = data;

            const isAdmin = (user?.scopes || []).includes("admin:all");
            let targetUserId = clientUserId ? normalizeUserId(clientUserId) : normalizeUserId(user?.id);
            const userId = verifyUserAccess(user, targetUserId) || undefined;

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

            return {
                success: true,
                sessionId: sessionId,
                memoryId: result.id,
                startedAt: nowTs,
                userId: userId,
                projectName: projectName,
                ideName: ideName,
            };
        })

        /**
         * POST /api/ide/session/end
         * Signals the end of a coding session and generates a summary.
         */
        .post("/session/end", async ({ body, ...ctx }) => {
            const data = IdeSessionEndSchema.parse(body);
            const user = getUser(ctx);
            if (!user?.scopes.includes("memory:write") && !user?.scopes.includes("admin:all")) {
                throw new AppError(403, "FORBIDDEN", "Missing scope: memory:write");
            }

            const { sessionId } = data;
            const userId = verifyUserAccess(user, normalizeUserId(user?.id)); // Ensure context is valid if needed
            const nowTs = Date.now();
            // Sanitize sessionId for LIKE pattern (escape special chars)
            const escapedSessionId = sessionId.replace(/[%_\\]/g, '\\$&');
            // Use standardized metadata field for search
            const sessionMemories = await q.getMemByMetadataLike.all(
                `%"ideSessionId":"${escapedSessionId}"%`,
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
                userId: userId || undefined,
            });

            return {
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
            };
        })

        /**
         * GET /api/ide/patterns/:sessionId
         * Detects coding patterns from the specified session.
         */
        .get("/patterns/:sessionId", async ({ params, ...ctx }) => {
            // Validate params manually or via Elysia schema? Manual usually easier with generic plugins
            const { sessionId } = params;
            if (!sessionId) throw new AppError(400, "BAD_REQUEST", "sessionId required");

            const user = getUser(ctx);
            if (!user?.scopes.includes("memory:read") && !user?.scopes.includes("admin:all")) {
                throw new AppError(403, "FORBIDDEN", "Missing scope: memory:read");
            }

            const userId = user?.id; // Allow undefined if user is not present (though auth middleware should handle)

            // Note: Session validation could be added here if needed
            // const activeSession = await q.ideQuery.getActiveSession(sessionId, userId || undefined);

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

            return {
                success: true,
                sessionId: sessionId,
                patternCount: result.patterns.length,
                patterns: result.patterns,
            };
        });
});
