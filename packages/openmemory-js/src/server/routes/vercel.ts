import { hsg_query, add_hsg_memory, hsg_q_result } from "../../memory/hsg";
import { j } from "../../utils";
import { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import { z } from "zod";

const VercelQuerySchema = z.object({
    query: z.string().min(1).max(4000),
    k: z.number().min(1).max(32).optional().default(8),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    user_id: z.string().optional()
});

const VercelMemorySchema = z.object({
    content: z.string().min(1),
    tags: z.array(z.string()).optional().default([]),
    metadata: z.record(z.any()).optional(),
    user_id: z.string().optional()
});

export function vercel(app: any) {
    // Simple memory query endpoint for Vercel AI SDK adapters
    app.post("/query", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = VercelQuerySchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid query parameters", validated.error.format()));
            }

            const { query, k, startTime, endTime } = validated.data;
            const user_id = req.user?.id; // Use authenticated user_id if present

            const matches = await hsg_query(query, k, { user_id, startTime, endTime });
            const lines = matches.map((m: hsg_q_result) => `- (${(m.score ?? 0).toFixed(2)}) ${m.content}`);
            const result = lines.join("\n");

            res.json({
                query,
                user_id: user_id || null,
                k,
                result,
                matches: matches.map((m: hsg_q_result) => ({
                    id: m.id,
                    content: m.content,
                    score: m.score,
                    sectors: m.sectors,
                    primary_sector: m.primary_sector,
                    last_seen_at: m.last_seen_at,
                })),
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    // Simple memory store endpoint for chat transcripts or summaries
    app.post("/memories", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = VercelMemorySchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid memory parameters", validated.error.format()));
            }

            const { content, tags, metadata } = validated.data;
            const user_id = req.user?.id;

            const r = await add_hsg_memory(content, j(tags), metadata, user_id);
            res.json(r);
        } catch (e: unknown) {
            sendError(res, e);
        }
    });
}
