import { z } from "zod";
import { Context } from "../server";
import logger from "../../core/logger";

// Schema based on AGENTS.md specification
const agentRequestSchema = z.object({
    id: z.string().min(1),
    goal: z.string().min(1),
    files: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    tests: z.array(z.string()).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    dry_run: z.boolean().optional(),
});

const agentResponseSchema = z.object({
    status: z.enum(["accepted", "in_progress", "completed", "blocked", "rejected"]),
    patch: z.string().optional(),
    summary: z.string().optional(),
    tests: z.record(z.string(), z.object({
        status: z.string(),
        output: z.string(),
    })).optional(),
    artifacts: z.array(z.string()).optional(),
});

export function agent(app: any) {
    app.post("/agent", async (req: Request, ctx: Context) => {
        // Some callers or test harnesses may not have the global body parser
        // applied. As with other routes, attempt to recover by parsing the
        // raw request body when `ctx.body` is undefined or null so tests and
        // clients that send JSON still work. Use a cloned request first to
        // avoid "Body already used" errors when the stream has already
        // been consumed by earlier middleware.
        if (ctx.body === undefined || ctx.body === null) {
            try {
                let text: string | undefined = undefined;
                if (typeof (req as any).clone === 'function') {
                    try { text = await (req as any).clone().text(); } catch (e) { text = undefined; }
                }
                if (!text && typeof (req as any).text === 'function') {
                    try { text = await req.text(); } catch (e) { text = undefined; }
                }
                if (text && text.length) {
                    try { ctx.body = JSON.parse(text); } catch (e) { /* leave as null; validation will catch */ }
                }
            } catch (e) { /* ignore and fall through to validation */ }
        }

        const validation = agentRequestSchema.safeParse(ctx.body);
        if (!validation.success) {
            return new Response(
                JSON.stringify({
                    status: "rejected",
                    error: "invalid_request",
                    issues: validation.error.issues
                }),
                { status: 400, headers: { "Content-Type": "application/json" } }
            );
        }

        const request = validation.data;

        try {
            logger.info({ component: "AGENT", request_id: request.id }, `[AGENT] Received agent request: ${request.goal}`);

            // For now, return a basic response indicating the endpoint is available
            // but the full agent implementation is not yet complete
            const response = {
                status: "accepted" as const,
                summary: `Agent request '${request.id}' received. Goal: ${request.goal}. Full agent implementation pending.`,
                artifacts: []
            };

            // Validate response matches expected schema
            const responseValidation = agentResponseSchema.safeParse(response);
            if (!responseValidation.success) {
                logger.error({ component: "AGENT", err: responseValidation.error }, "[AGENT] Response validation failed");
                throw new Error("Internal response validation failed");
            }

            logger.info({ component: "AGENT", request_id: request.id, status: response.status }, `[AGENT] Responded to agent request`);

            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });

        } catch (e: any) {
            logger.error({ component: "AGENT", request_id: request.id, err: e }, `[AGENT] Error processing agent request: ${e.message}`);

            const errorResponse = {
                status: "rejected" as const,
                summary: `Error processing agent request: ${e.message}`,
                artifacts: []
            };

            return new Response(JSON.stringify(errorResponse), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }
    });
}