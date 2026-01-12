import { z } from "zod";

import { HsgQueryResult } from "../../core/types";
import { addHsgMemory, hsgQuery } from "../../memory/hsg";
import { sendError } from "../errors";
import { validateBody } from "../middleware/validate";
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

const VercelQuerySchema = z.object({
    query: z.string().min(1).max(4000),
    k: z.number().min(1).max(32).optional().default(8),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    userId: z.string().optional(),
});

type VercelQuery = z.infer<typeof VercelQuerySchema>;

const VercelMemorySchema = z.object({
    content: z.string().min(1),
    tags: z.array(z.string()).optional().default([]),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

type VercelMemory = z.infer<typeof VercelMemorySchema>;

export function vercelRoutes(app: ServerApp) {
    /**
     * Simple memory query endpoint for Vercel AI SDK adapters.
     * Supports filtering by time range and multi-tenant user isolation.
     */
    app.post(
        "/query",
        validateBody(VercelQuerySchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { query, k, startTime, endTime, userId: bodyUserId } =
                    req.body as VercelQuery;
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                const userId = isAdmin && bodyUserId ? bodyUserId : req.user?.id;

                const matches = await hsgQuery(query, k, {
                    userId,
                    startTime,
                    endTime,
                });
                const lines = matches.map(
                    (m: HsgQueryResult) =>
                        `- (${(m.score ?? 0).toFixed(2)}) ${m.content}`,
                );
                const result = lines.join("\n");

                res.json({
                    query,
                    userId: userId || null,
                    k,
                    result,
                    matches: matches.map((m: HsgQueryResult) => ({
                        id: m.id,
                        content: m.content,
                        score: m.score,
                        sectors: m.sectors,
                        primarySector: m.primarySector,
                        lastSeenAt: m.lastSeenAt,
                    })),
                });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    /**
     * Simple memory store endpoint for chat transcripts, summaries, or general ingest.
     * Compatible with Vercel AI SDK 'save' callbacks.
     */
    app.post(
        "/memories",
        validateBody(VercelMemorySchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { content, tags, metadata, userId: bodyUserId } = req.body as VercelMemory;
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                const userId = isAdmin && bodyUserId ? bodyUserId : req.user?.id;

                // Pass tags via metadata to avoid double JSON serialization/parsing
                const r = await addHsgMemory(
                    content,
                    null,
                    { ...metadata, tags },
                    userId,
                );
                res.json(r);
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );
}
