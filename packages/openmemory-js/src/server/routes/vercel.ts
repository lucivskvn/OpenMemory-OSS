import { Elysia } from "elysia";
import { z } from "zod";

import { HsgQueryResult, UserContext } from "../../core/types";
import { addHsgMemory, hsgQuery } from "../../memory/hsg";
import { AppError } from "../errors";
import { getUser, getEffectiveUserId } from "../middleware/auth";

const VercelQuerySchema = z.object({
    query: z.string().min(1).max(4000),
    k: z.number().min(1).max(32).optional().default(8),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    userId: z.string().optional(),
});

const VercelMemorySchema = z.object({
    content: z.string().min(1),
    tags: z.array(z.string()).optional().default([]),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

export const vercelRoutes = (app: Elysia) => app.group("/", (app) => {
    return app
        /**
         * Simple memory query endpoint for Vercel AI SDK adapters.
         * Supports filtering by time range and multi-tenant user isolation.
         */
        .post("/query", async ({ body, ...ctx }) => {
            const { query, k, startTime, endTime, userId: bodyUserId } = VercelQuerySchema.parse(body);
            const user = getUser(ctx);

            const userId = getEffectiveUserId(user, bodyUserId);

            // If no user and not admin/auth, what?
            // The original code: req.user?.id. If undefined, it passed undefined to hsgQuery?
            // hsgQuery(..., { userId })

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

            return {
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
            };
        })

        /**
         * Simple memory store endpoint for chat transcripts, summaries, or general ingest.
         * Compatible with Vercel AI SDK 'save' callbacks.
         */
        .post("/memories", async ({ body, ...ctx }) => {
            const { content, tags, metadata, userId: bodyUserId } = VercelMemorySchema.parse(body);
            const user = getUser(ctx);
            const userId = getEffectiveUserId(user, bodyUserId);

            // Pass tags via metadata to avoid double JSON serialization/parsing
            const r = await addHsgMemory(
                content,
                null,
                { ...metadata, tags },
                userId,
            );
            return r;
        });
});
