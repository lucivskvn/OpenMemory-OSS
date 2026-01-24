import { Elysia } from "elysia";
import { z } from "zod";

import { Memory } from "../../core/memory";
import { safeDate } from "../../utils";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";
import type { UserContext } from "../middleware/auth";
import { normalizeUserId } from "../../utils";
import { verifyUserAccess, getUser, getEffectiveUserId } from "../middleware/auth";

// --- Schemas ---
const FactSchema = z.object({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    object: z.string().min(1),
    validFrom: z.string().or(z.number()).optional(),
    confidence: z.number().min(0).max(1).optional().default(1.0),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

const QueryFactSchema = z.object({
    subject: z.string().optional(),
    predicate: z.string().optional(),
    object: z.string().optional(),
    at: z.string().or(z.number()).optional(),
    minConfidence: z.coerce.number().optional().default(0.1),
    userId: z.string().optional(),
});

export const CurrentFactSchema = z.object({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    at: z.string().or(z.number()).optional(),
    userId: z.string().optional(),
});

export const TimelineSchema = z.object({
    subject: z.string().min(1),
    predicate: z.string().optional(),
    userId: z.string().optional(),
});

export const PredicateHistorySchema = z.object({
    predicate: z.string().min(1),
    from: z.string().or(z.number()).optional(),
    to: z.string().or(z.number()).optional(),
    userId: z.string().optional(),
});

export const UpdateFactSchema = z.object({
    confidence: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

export const InvalidateSchema = z.object({
    validTo: z.string().or(z.number()).optional(),
    userId: z.string().optional(),
});

export const SubjectFactsSchema = z.object({
    at: z.string().or(z.number()).optional(),
    includeHistorical: z.coerce.boolean().optional(),
    limit: z.coerce.number().max(1000).optional(),
    userId: z.string().optional(),
});

export const SearchFactsSchema = z.object({
    pattern: z.string().min(1),
    type: z
        .enum(["subject", "predicate", "object", "all"])
        .optional()
        .default("all"),
    at: z.string().or(z.number()).optional(),
    limit: z.coerce.number().max(1000).optional(),
    userId: z.string().optional(),
});

export const VolatileSchema = z.object({
    subject: z.string().optional(),
    limit: z.coerce.number().max(1000).optional().default(10),
    userId: z.string().optional(),
});

export const CreateEdgeSchema = z.object({
    sourceId: z.string().min(1),
    targetId: z.string().min(1),
    relationType: z.string().min(1),
    validFrom: z.string().or(z.number()).optional(),
    weight: z.number().min(0).max(1).optional().default(1.0),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

export const EdgeQuerySchema = z.object({
    sourceId: z.string().optional(),
    targetId: z.string().optional(),
    relationType: z.string().optional(),
    at: z.string().or(z.number()).optional(),
    limit: z.coerce.number().max(1000).optional(),
    offset: z.coerce.number().optional(),
    userId: z.string().optional(),
});

export const DecaySchema = z.object({
    decayRate: z.number().optional(),
    userId: z.string().optional(),
});

export const CompareSchema = z.object({
    subject: z.string().min(1),
    time1: z.string().or(z.number()).optional(),
    time2: z.string().or(z.number()).optional(),
    userId: z.string().optional(),
});

export const GraphContextSchema = z.object({
    factId: z.string().min(1),
    relationType: z.string().optional(),
    at: z.string().or(z.number()).optional(),
    userId: z.string().optional(),
});

export const UpdateEdgeSchema = z.object({
    weight: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

export const IdParamsSchema = z.object({
    id: z.string().min(1),
});

export const SubjectParamsSchema = z.object({
    subject: z.string().min(1),
});

/**
 * Registers Temporal Memory routes.
 */
export const temporalRoutes = (app: Elysia) => app.group("/temporal", (app) => {

    return app
        /**
         * POST /temporal/fact
         * Creates a new temporal fact.
         */
        .post("/fact", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = FactSchema.parse(body);
            const effectiveUserId = getEffectiveUserId(user, b.userId);

            const validFromDate = b.validFrom
                ? safeDate(b.validFrom) || new Date()
                : new Date();

            const m = new Memory(effectiveUserId);
            const id = await m.temporal.add(
                b.subject,
                b.predicate,
                b.object,
                {
                    validFrom: validFromDate,
                    confidence: b.confidence,
                    metadata: b.metadata,
                }
            );

            return {
                id,
                subject: b.subject,
                predicate: b.predicate,
                object: b.object,
                validFrom: validFromDate.getTime(),
                confidence: b.confidence,
                message: "Fact created successfully",
            };
        })

        /**
         * GET /temporal/fact
         * Retrieves temporal facts based on query parameters.
         */
        .get("/fact", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const q = QueryFactSchema.parse(query);

            if (!q.subject && !q.predicate && !q.object) {
                throw new AppError(400, "MISSING_QUERY", "At least one of subject, predicate, or object is required");
            }

            const atDate = q.at ? safeDate(q.at) : new Date();
            if (q.at && !atDate) {
                throw new AppError(400, "INVALID_DATE", "Invalid 'at' date format");
            }

            const minConf = q.minConfidence ?? 0.1;
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const m = new Memory(effectiveUserId);
            const facts = await m.temporal.queryFacts(
                q.subject,
                q.predicate,
                q.object,
                atDate!,
                minConf,
            );

            return {
                facts,
                query: {
                    subject: q.subject,
                    predicate: q.predicate,
                    object: q.object,
                    at: atDate!.toISOString(),
                    minConfidence: minConf,
                },
                count: facts.length,
            };
        })

        /**
         * GET /temporal/fact/current
         * Retrieves the current fact for a subject/predicate.
         */
        .get("/fact/current", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const q = CurrentFactSchema.parse(query);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const m = new Memory(effectiveUserId);
            const fact = await m.temporal.get(
                q.subject,
                q.predicate,
            );

            if (!fact) {
                throw new AppError(404, "NOT_FOUND", "No current fact found", {
                    subject: q.subject,
                    predicate: q.predicate,
                });
            }

            return { fact };
        })

        /**
         * PATCH /temporal/fact/:id
         * Updates a temporal fact.
         */
        .patch("/fact/:id", async ({ params, body, ...ctx }) => {
            const user = getUser(ctx);
            const p = IdParamsSchema.parse(params);
            const b = UpdateFactSchema.parse(body);

            const effectiveUserId = getEffectiveUserId(user, b.userId);

            const m = new Memory(effectiveUserId);
            await m.temporal.updateFact(p.id, b.confidence, b.metadata);

            return {
                id: p.id,
                message: "Fact updated successfully",
            };
        })

        /**
         * DELETE /temporal/fact/:id
         * Invalidates a temporal fact (soft delete with validTo).
         */
        .delete("/fact/:id", async ({ params, body, ...ctx }) => {
            const user = getUser(ctx);
            const p = IdParamsSchema.parse(params);
            const b = InvalidateSchema.parse(body);
            const effectiveUserId = getEffectiveUserId(user, b.userId);

            const validToDate = b.validTo
                ? safeDate(b.validTo) || new Date()
                : new Date();

            const m = new Memory(effectiveUserId);
            await m.temporal.invalidateFact(p.id, validToDate);

            return {
                id: p.id,
                validTo: validToDate.toISOString(),
                message: "Fact invalidated successfully",
            };
        })

        /**
         * GET /temporal/timeline
         * Retrieves the timeline for an entity.
         */
        .get("/timeline", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const q = TimelineSchema.parse(query);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const m = new Memory(effectiveUserId);
            const timeline = await m.temporal.history(q.subject, q.predicate);

            return {
                subject: q.subject,
                predicate: q.predicate,
                timeline,
                count: timeline.length,
            };
        })

        /**
         * GET /temporal/history/predicate
         * Retrieves the history of a predicate.
         */
        .get("/history/predicate", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const q = PredicateHistorySchema.parse(query);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const fromDate = q.from ? safeDate(q.from) : undefined;
            const toDate = q.to ? safeDate(q.to) : undefined;

            const m = new Memory(effectiveUserId);
            const timeline = await m.temporal.getPredicateHistory(
                q.predicate,
                fromDate,
                toDate,
            );

            return {
                predicate: q.predicate,
                from: fromDate?.toISOString(),
                to: toDate?.toISOString(),
                timeline,
                count: timeline.length,
            };
        })

        /**
         * GET /temporal/compare
         * Compares facts at two points in time.
         */
        .get("/compare", async ({ query, ...ctx }) => {
            const q = CompareSchema.parse(query);

            const t2 = q.time2 ? safeDate(q.time2) : new Date();
            const t1 = q.time1 ? safeDate(q.time1) : new Date(Date.now() - 86400000); // Default to 24h ago

            if (!t1 || !t2) {
                throw new AppError(400, "INVALID_DATE", "Invalid date format");
            }

            const user = getUser(ctx);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const m = new Memory(effectiveUserId);
            const comparison = await m.temporal.compare(
                q.subject,
                t1,
                t2
            );

            return {
                subject: q.subject,
                time1: t1.toISOString(),
                time2: t2.toISOString(),
                comparison,
            };
        })

        /**
         * GET /temporal/graph-context
         * Retrieves graph context for a fact.
         */
        .get("/graph-context", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const q = GraphContextSchema.parse(query);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const atDate = q.at ? safeDate(q.at) : new Date();

            const m = new Memory(effectiveUserId);
            const results = await m.temporal.getGraphContext(
                q.factId,
                { relationType: q.relationType, at: atDate }
            );

            return { results };
        })

        /**
         * GET /temporal/stats
         * Retrieves stats about temporal memory.
         * Only admin or authenticated user should probably see this?
         */
        .get("/stats", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const effectiveUserId = getEffectiveUserId(user, (query as any).userId);

            const m = new Memory(effectiveUserId);
            const stats = await m.temporal.stats();
            return stats;
        })

        /**
         * POST /temporal/decay
         * Applies time-based decay.
         */
        .post("/decay", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = DecaySchema.parse(body);
            const effectiveUserId = getEffectiveUserId(user, b.userId);

            const m = new Memory(effectiveUserId);
            const changes = await m.temporal.decay(b.decayRate);

            return {
                message: "Decay applied successfully",
                factsUpdated: changes,
            };
        })

        /**
         * GET /temporal/volatile
         * Retrieves most volatile facts.
         */
        .get("/volatile", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const q = VolatileSchema.parse(query);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const m = new Memory(effectiveUserId);
            try {
                const volatile = await m.temporal.volatile(q.subject, q.limit);
                return {
                    subject: q.subject,
                    limit: q.limit,
                    volatileFacts: volatile.volatileFacts,
                    count: volatile.count,
                };
            } catch (err: any) {
                logger.error("Failed to get volatile facts", { error: err });
                return { subject: q.subject, limit: q.limit, volatileFacts: [], count: 0 };
            }
        })

        /**
         * POST /temporal/edge
         * Creates a new temporal edge.
         */
        .post("/edge", async ({ body, ...ctx }) => {
            const user = getUser(ctx);
            const b = CreateEdgeSchema.parse(body);
            const effectiveUserId = getEffectiveUserId(user, b.userId);

            const validFromDate = b.validFrom
                ? safeDate(b.validFrom) || new Date()
                : new Date();

            const m = new Memory(effectiveUserId);
            const id = await m.temporal.addEdge(
                b.sourceId,
                b.targetId,
                b.relationType,
                {
                    validFrom: validFromDate,
                    weight: b.weight,
                    metadata: b.metadata
                }
            );

            return {
                id,
                sourceId: b.sourceId,
                targetId: b.targetId,
                relationType: b.relationType,
                validFrom: validFromDate.getTime(),
                ok: true,
                success: true,
                message: "Edge created successfully",
            };
        })

        /**
         * GET /temporal/edge
         * Retrieves temporal edges.
         */
        .get("/edge", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const q = EdgeQuerySchema.parse(query);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const atDate = q.at ? safeDate(q.at as string | number) : new Date();
            if (q.at && !atDate) {
                throw new AppError(400, "INVALID_DATE", "Invalid 'at' date format");
            }
            const limitVal = q.limit || 100;
            const offsetVal = q.offset || 0;

            const m = new Memory(effectiveUserId);
            const edges = await m.temporal.getEdges(
                q.sourceId,
                q.targetId,
                q.relationType,
                atDate!,
                limitVal,
                offsetVal,
            );

            return { edges, count: edges.length };
        })

        /**
         * DELETE /temporal/edge/:id
         * Invalidates a temporal edge.
         */
        .delete("/edge/:id", async ({ params, body, ...ctx }) => {
            const user = getUser(ctx);
            const p = IdParamsSchema.parse(params);
            const b = InvalidateSchema.parse(body);
            const effectiveUserId = getEffectiveUserId(user, b.userId);

            const validToDate = b.validTo
                ? safeDate(b.validTo) || new Date()
                : new Date();

            const m = new Memory(effectiveUserId);
            await m.temporal.invalidateEdge(p.id, validToDate);

            return {
                id: p.id,
                validTo: validToDate.toISOString(),
                message: "Edge invalidated successfully",
            };
        })

        /**
         * PATCH /temporal/edge/:id
         * Updates a temporal edge.
         */
        .patch("/edge/:id", async ({ params, body, ...ctx }) => {
            const user = getUser(ctx);
            const p = IdParamsSchema.parse(params);
            const b = UpdateEdgeSchema.parse(body);
            const effectiveUserId = getEffectiveUserId(user, b.userId);

            const m = new Memory(effectiveUserId);
            await m.temporal.updateEdge(p.id, b.weight, b.metadata);

            return {
                id: p.id,
                message: "Edge updated successfully",
            };
        })

        /**
         * GET /temporal/subject/:subject
         * Retrieves facts for a specific subject.
         * NOTE: Placing this LAST to avoid collision if we had other routes starting with /temporal/subject... but we don't.
         */
        .get("/subject/:subject", async ({ params, query, ...ctx }) => {
            const user = getUser(ctx);
            const p = SubjectParamsSchema.parse(params);
            const q = SubjectFactsSchema.parse(query);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const atDate = q.at ? safeDate(q.at) : undefined;
            if (q.at && !atDate) {
                throw new AppError(400, "INVALID_DATE", "Invalid 'at' date format");
            }

            const includeHist = q.includeHistorical === true;
            const limitVal = q.limit || 100;

            const m = new Memory(effectiveUserId);
            const facts = await m.temporal.getFactsBySubject(
                p.subject,
                atDate || undefined,
                includeHist,
                limitVal
            );

            return {
                subject: p.subject,
                at: atDate?.toISOString(),
                includeHistorical: includeHist,
                facts,
                count: facts.length,
            };
        })

        /**
         * GET /temporal/search
         * Searches temporal facts.
         */
        .get("/search", async ({ query, ...ctx }) => {
            const user = getUser(ctx);
            const q = SearchFactsSchema.parse(query);
            const effectiveUserId = getEffectiveUserId(user, q.userId);

            const atDate = q.at ? safeDate(q.at as string | number) : undefined;
            if (q.at && !atDate) {
                throw new AppError(400, "INVALID_DATE", "Invalid 'at' date format");
            }
            const limitValue = q.limit || 100;

            const m = new Memory(effectiveUserId);
            const facts = await m.temporal.search(
                q.pattern,
                {
                    type: q.type as any,
                    at: atDate,
                    limit: limitValue
                }
            );

            return {
                pattern: q.pattern,
                type: q.type,
                at: atDate?.toISOString(),
                facts,
                count: facts.length,
            };
        });

});
