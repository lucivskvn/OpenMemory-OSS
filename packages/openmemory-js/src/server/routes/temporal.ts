import { z } from "zod";

import { Memory } from "../../core/memory";
import { safeDate } from "../../utils";
import { logger } from "../../utils/logger";
import { AppError, sendError } from "../errors";
import { validateBody, validateQuery } from "../middleware/validate";
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

const FactSchema = z.object({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    object: z.string().min(1),
    validFrom: z.string().or(z.number()).optional(),
    confidence: z.number().min(0).max(1).optional().default(1.0),
    metadata: z.record(z.string(), z.any()).optional(),
});

const QueryFactSchema = z.object({
    subject: z.string().optional(),
    predicate: z.string().optional(),
    object: z.string().optional(),
    at: z.string().or(z.number()).optional(),
    minConfidence: z.coerce.number().optional().default(0.1),
});

type FactBody = z.infer<typeof FactSchema>;
type QueryFact = z.infer<typeof QueryFactSchema>;

export const CurrentFactSchema = z.object({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    at: z.string().or(z.number()).optional(),
});

export const TimelineSchema = z.object({
    subject: z.string().min(1),
    predicate: z.string().optional(),
});

export const PredicateHistorySchema = z.object({
    predicate: z.string().min(1),
    from: z.string().or(z.number()).optional(),
    to: z.string().or(z.number()).optional(),
});

export const UpdateFactSchema = z.object({
    confidence: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
});

export const InvalidateSchema = z.object({
    validTo: z.string().or(z.number()).optional(),
});

export const SubjectFactsSchema = z.object({
    at: z.string().or(z.number()).optional(),
    includeHistorical: z.coerce.boolean().optional(),
    limit: z.coerce.number().optional(),
});

export const SearchFactsSchema = z.object({
    pattern: z.string().min(1),
    type: z
        .enum(["subject", "predicate", "object", "all"])
        .optional()
        .default("all"),
    at: z.string().or(z.number()).optional(),
    limit: z.coerce.number().optional(),
});

export const VolatileSchema = z.object({
    subject: z.string().optional(),
    limit: z.coerce.number().optional().default(10),
});

export const CreateEdgeSchema = z.object({
    sourceId: z.string().min(1),
    targetId: z.string().min(1),
    relationType: z.string().min(1),
    validFrom: z.string().or(z.number()).optional(),
    weight: z.number().min(0).max(1).optional().default(1.0),
    metadata: z.record(z.string(), z.any()).optional(),
});

export const EdgeQuerySchema = z.object({
    sourceId: z.string().optional(),
    targetId: z.string().optional(),
    relationType: z.string().optional(),
    at: z.string().or(z.number()).optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
});

export const DecaySchema = z.object({
    decayRate: z.number().optional(),
});

export const CompareSchema = z.object({
    subject: z.string().min(1),
    time1: z.string().or(z.number()).optional(),
    time2: z.string().or(z.number()).optional(),
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
});

// Utility safeDate imported from ../../utils
import { normalizeUserId } from "../../utils";

/**
 * Helper to resolve the user context based on auth scope and request parameters.
 * Enforces tenant isolation for non-admin users.
 */
const getEffectiveUserId = (req: AdvancedRequest, overrideUserId?: string): string | null | undefined => {
    const isAdmin = (req.user?.scopes || []).includes("admin:all");
    let userId = req.user?.id;

    if (isAdmin && overrideUserId) {
        userId = overrideUserId;
    } else if (!userId) {
        // Unauthenticated (Open Mode) or Fallback
        userId = overrideUserId;
    }

    return normalizeUserId(userId);
};

export const createTemporalFact = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { subject, predicate, object, validFrom, confidence, metadata, userId: bodyUserId } =
            req.body as FactBody & { userId?: string };

        const effectiveUserId = getEffectiveUserId(req, bodyUserId);

        const validFromDate = validFrom
            ? safeDate(validFrom) || new Date()
            : new Date();

        const m = new Memory(effectiveUserId);
        const id = await m.temporal.add(
            subject,
            predicate,
            object,
            {
                validFrom: validFromDate,
                confidence,
                metadata,
            }
        );

        res.json({
            id,
            subject,
            predicate,
            object,
            validFrom: validFromDate.getTime(),
            confidence,
            message: "Fact created successfully",
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error creating fact:", { error });
        sendError(res, error);
    }
};

// [Modified] getTemporalFact
export const getTemporalFact = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const query = req.query as unknown as QueryFact;
        const { subject, predicate, object, at, minConfidence } = query;

        if (!subject && !predicate && !object) {
            return sendError(
                res,
                new AppError(
                    400,
                    "MISSING_QUERY",
                    "At least one of subject, predicate, or object is required",
                ),
            );
        }

        const atDate = at ? safeDate(at) : new Date();
        if (at && !atDate) {
            return sendError(
                res,
                new AppError(400, "INVALID_DATE", "Invalid 'at' date format"),
            );
        }

        // Coerced by Zod
        const minConf = minConfidence ?? 0.1;
        const effectiveUserId = getEffectiveUserId(req, (query as any).userId);

        const m = new Memory(effectiveUserId);
        const facts = await m.temporal.queryFacts(
            subject,
            predicate,
            object,
            atDate!,
            minConf,
        );

        res.json({
            facts,
            query: {
                subject,
                predicate,
                object,
                at: atDate!.toISOString(),
                minConfidence: minConf,
            },
            count: facts.length,
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error querying facts:", { error });
        sendError(res, error);
    }
};

export const getCurrentTemporalFact = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { subject, predicate, at, userId: queryUserId } = req.query as unknown as z.infer<
            typeof CurrentFactSchema
        > & { userId?: string };

        const atDate = at ? safeDate(at) : new Date();
        const effectiveUserId = getEffectiveUserId(req, queryUserId);

        const m = new Memory(effectiveUserId);
        const fact = await m.temporal.get(
            subject,
            predicate,
        );

        if (!fact) {
            return sendError(
                res,
                new AppError(404, "NOT_FOUND", "No current fact found", {
                    subject,
                    predicate,
                }),
            );
        }

        res.json({ fact });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error getting current fact:", { error });
        sendError(res, error);
    }
};

export const getTemporalGraphContext = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { factId, relationType, at, userId } = req.query as unknown as z.infer<
            typeof GraphContextSchema
        >;
        const effectiveUserId = getEffectiveUserId(req, userId);

        const atDate = at ? safeDate(at) : new Date();

        const m = new Memory(effectiveUserId);
        const results = await m.temporal.getGraphContext(
            factId,
            relationType,
            atDate,
        );

        res.json({ results });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error getting graph context:", { error });
        sendError(res, error);
    }
};

export const updateTemporalFact = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { id } = req.params;
        if (!id)
            return sendError(
                res,
                new AppError(400, "MISSING_ID", "Fact ID is required"),
            );

        const { confidence, metadata, userId: bodyUserId } = req.body as z.infer<
            typeof UpdateFactSchema
        > & { userId?: string };
        const effectiveUserId = getEffectiveUserId(req, bodyUserId);

        const m = new Memory(effectiveUserId);
        await m.temporal.updateFact(id, confidence, metadata);

        res.json({
            id,
            message: "Fact updated successfully",
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error updating fact:", { error });
        sendError(res, error);
    }
};

export const invalidateTemporalFact = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { id } = req.params;
        if (!id)
            return sendError(
                res,
                new AppError(400, "MISSING_ID", "Fact ID is required"),
            );

        const { validTo, userId: bodyUserId } = req.body as z.infer<typeof InvalidateSchema> & { userId?: string };
        const effectiveUserId = getEffectiveUserId(req, bodyUserId);

        const validToDate = validTo
            ? safeDate(validTo) || new Date()
            : new Date();

        const m = new Memory(effectiveUserId);
        await m.temporal.invalidateFact(id, validToDate);

        res.json({
            id,
            validTo: validToDate.toISOString(),
            message: "Fact invalidated successfully",
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error invalidating fact:", { error });
        sendError(res, error);
    }
};

export const getEntityTimeline = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { subject, predicate, userId: queryUserId } = req.query as unknown as z.infer<
            typeof TimelineSchema
        > & { userId?: string };

        const effectiveUserId = getEffectiveUserId(req, queryUserId);

        const m = new Memory(effectiveUserId);
        const timeline = await m.temporal.history(subject, predicate);

        res.json({
            subject,
            predicate,
            timeline,
            count: timeline.length,
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error getting timeline:", { error });
        sendError(res, error);
    }
};

export const getPredicateHistory = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { predicate, from, to, userId: queryUserId } = req.query as unknown as z.infer<
            typeof PredicateHistorySchema
        > & { userId?: string };

        const fromDate = from ? safeDate(from) : undefined;
        const toDate = to ? safeDate(to) : undefined;
        const effectiveUserId = getEffectiveUserId(req, queryUserId);

        const m = new Memory(effectiveUserId);
        const timeline = await m.temporal.getPredicateHistory(
            predicate,
            fromDate,
            toDate,
        );

        res.json({
            predicate,
            from: fromDate?.toISOString(),
            to: toDate?.toISOString(),
            timeline,
            count: timeline.length,
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error getting predicate timeline:", {
            error,
        });
        sendError(res, error);
    }
};

export const getSubjectFacts = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { subject } = req.params;
        if (!subject)
            return sendError(
                res,
                new AppError(
                    400,
                    "MISSING_SUBJECT",
                    "Subject parameter is required",
                ),
            );

        const { at, includeHistorical, limit } = req.query as unknown as z.infer<
            typeof SubjectFactsSchema
        >;
        const atDate = at ? safeDate(at) : undefined;
        if (at && !atDate) {
            return sendError(
                res,
                new AppError(400, "INVALID_DATE", "Invalid 'at' date format"),
            );
        }

        // Coerced by Zod
        const includeHist = includeHistorical === true;
        const limitVal = limit || 100;
        const effectiveUserId = getEffectiveUserId(req, (req.query as any).userId);

        const m = new Memory(effectiveUserId);
        const facts = await m.temporal.getFactsBySubject(
            subject,
            atDate || undefined,
            includeHist,
            limitVal
        );

        res.json({
            subject,
            at: atDate?.toISOString(),
            includeHistorical: includeHist,
            facts,
            count: facts.length,
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error getting subject facts:", { error });
        sendError(res, error);
    }
};

export const searchTemporalFacts = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { pattern, type, at, limit } = req.query as unknown as z.infer<
            typeof SearchFactsSchema
        >;
        const atDate = at ? safeDate(at) : undefined;
        if (at && !atDate) {
            return sendError(
                res,
                new AppError(400, "INVALID_DATE", "Invalid 'at' date format"),
            );
        }
        const limitValue = limit || 100;
        const effectiveUserId = getEffectiveUserId(req, (req.query as any).userId);

        const m = new Memory(effectiveUserId);
        const facts = await m.temporal.search(
            pattern,
            {
                type: type as any,
                at: atDate,
                limit: limitValue
            }
        );

        res.json({
            pattern,
            type,
            at: atDate?.toISOString(),
            facts,
            count: facts.length,
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error searching facts:", { error });
        sendError(res, error);
    }
};

export const compareFacts = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { subject, time1, time2 } = req.query as unknown as z.infer<
            typeof CompareSchema
        >;

        const t2 = time2 ? safeDate(time2) : new Date();
        const t1 = time1 ? safeDate(time1) : new Date(Date.now() - 86400000); // Default to 24h ago

        if (!t1 || !t2) {
            return sendError(
                res,
                new AppError(400, "INVALID_DATE", "Invalid date format"),
            );
        }

        const effectiveUserId = getEffectiveUserId(req, (req.query as any).userId);

        const m = new Memory(effectiveUserId);
        const comparison = await m.temporal.compare(
            subject,
            t1,
            t2
        );

        res.json({
            subject,
            time1: t1.toISOString(),
            time2: t2.toISOString(),
            comparison,
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error comparing facts:", { error });
        sendError(res, error);
    }
};

export const getTemporalStats = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const effectiveUserId = getEffectiveUserId(req, (req.query as any).userId);

        const m = new Memory(effectiveUserId);
        const stats = await m.temporal.stats();

        // Facade stats returns { facts: { total, active }, edges: { total, active } }
        res.json(stats);

        // Original returned manually constructed:
        /*
        res.json({
            facts: {
                total: factCount,
                active: activeFactCount,
            },
            edges: {
                total: edgeCount,
                active: activeEdgeCount,
            },
        });
        */
        // Facade output matches exactly.
        return;
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error getting stats:", { error });
        sendError(res, error);
    }
};

export const applyDecay = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { decayRate, userId: bodyUserId } = req.body as z.infer<typeof DecaySchema> & { userId?: string };
        const effectiveUserId = getEffectiveUserId(req, bodyUserId);

        const m = new Memory(effectiveUserId);
        const changes = await m.temporal.decay(decayRate);

        res.json({
            message: "Decay applied successfully",
            changes,
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error applying decay:", { error });
        sendError(res, error);
    }
};

export const getMostVolatile = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { subject, limit } = req.query as unknown as z.infer<
            typeof VolatileSchema
        >;

        // Coerced by Zod
        const limitValue = limit || 10;
        const effectiveUserId = getEffectiveUserId(req, (req.query as any).userId);

        const m = new Memory(effectiveUserId);
        const volatile = await m.temporal.volatile(
            subject,
            limitValue
        );

        res.json({
            subject,
            limit: limitValue,
            volatileFacts: volatile,
            count: volatile.length,
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error getting volatile facts:", { error });
        sendError(res, error);
    }
};

export const createTemporalEdge = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const {
            sourceId,
            targetId,
            relationType,
            validFrom,
            weight,
            metadata,
            userId: bodyUserId,
        } = req.body as z.infer<typeof CreateEdgeSchema> & { userId?: string };

        const effectiveUserId = getEffectiveUserId(req, bodyUserId);

        const validFromDate = validFrom
            ? safeDate(validFrom) || new Date()
            : new Date();

        const m = new Memory(effectiveUserId);
        const id = await m.temporal.addEdge(
            sourceId,
            targetId,
            relationType,
            {
                validFrom: validFromDate,
                weight,
                metadata
            }
        );

        res.json({
            id,
            sourceId,
            targetId,
            relationType,
            validFrom: validFromDate.getTime(),
            ok: true,
            message: "Edge created successfully",
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error creating edge:", { error });
        sendError(res, error);
    }
};

export const getTemporalEdges = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { sourceId, targetId, relationType, at, limit, offset, userId: queryUserId } =
            req.query as unknown as z.infer<typeof EdgeQuerySchema> & { userId?: string };

        const effectiveUserId = getEffectiveUserId(req, queryUserId);
        const atDate = at ? safeDate(at) : new Date();
        const limitVal = limit || 100;
        const offsetVal = offset || 0;

        if (at && !atDate) {
            return sendError(
                res,
                new AppError(400, "INVALID_DATE", "Invalid 'at' date format"),
            );
        }

        const m = new Memory(effectiveUserId);
        const edges = await m.temporal.getEdges(
            sourceId,
            targetId,
            relationType,
            atDate!,
            limitVal,
            offsetVal,
        );

        res.json({ edges, count: edges.length });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error querying edges:", { error });
        sendError(res, error);
    }
};

export const invalidateTemporalEdge = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { id } = req.params;
        if (!id)
            return sendError(
                res,
                new AppError(400, "MISSING_ID", "Edge ID is required"),
            );

        const { validTo, userId: bodyUserId } = req.body as { validTo?: string | number, userId?: string };
        const effectiveUserId = getEffectiveUserId(req, bodyUserId);

        const validToDate = validTo
            ? safeDate(validTo) || new Date()
            : new Date();

        const m = new Memory(effectiveUserId);
        await m.temporal.invalidateEdge(id, validToDate);

        res.json({
            id,
            validTo: validToDate.toISOString(),
            message: "Edge invalidated successfully",
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error invalidating edge:", { error });
        sendError(res, error);
    }
};

export function temporalRoutes(app: ServerApp) {
    app.post(
        "/temporal/fact",
        validateBody(FactSchema),
        createTemporalFact,
    );
    app.get(
        "/temporal/fact",
        validateQuery(QueryFactSchema),
        getTemporalFact,
    );

    app.get(
        "/temporal/fact/current",
        validateQuery(CurrentFactSchema),
        getCurrentTemporalFact,
    );

    app.patch(
        "/temporal/fact/:id",
        validateBody(UpdateFactSchema),
        updateTemporalFact,
    );

    app.delete(
        "/temporal/fact/:id",
        validateBody(InvalidateSchema),
        invalidateTemporalFact,
    );

    app.get(
        "/temporal/timeline",
        validateQuery(TimelineSchema),
        getEntityTimeline,
    );

    app.get(
        "/temporal/history/predicate",
        validateQuery(PredicateHistorySchema),
        getPredicateHistory,
    );

    app.get(
        "/temporal/subject/:subject",
        validateQuery(SubjectFactsSchema),
        getSubjectFacts,
    );

    app.get(
        "/temporal/search",
        validateQuery(SearchFactsSchema),
        searchTemporalFacts,
    );

    app.get(
        "/temporal/compare",
        validateQuery(CompareSchema),
        compareFacts,
    );

    app.get(
        "/temporal/graph-context",
        validateQuery(GraphContextSchema),
        getTemporalGraphContext,
    );

    app.get("/temporal/stats", getTemporalStats);
    app.post("/temporal/decay", validateBody(DecaySchema), applyDecay);

    app.get(
        "/temporal/volatile",
        validateQuery(VolatileSchema),
        getMostVolatile,
    );

    app.post(
        "/temporal/edge",
        validateBody(CreateEdgeSchema),
        createTemporalEdge,
    );

    app.get(
        "/temporal/edge",
        validateQuery(EdgeQuerySchema),
        getTemporalEdges,
    );

    app.delete(
        "/temporal/edge/:id",
        validateBody(InvalidateSchema),
        invalidateTemporalEdge,
    );

    app.patch(
        "/temporal/edge/:id",
        validateBody(UpdateEdgeSchema),
        updateTemporalEdge,
    );
}

export const updateTemporalEdge = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const { id } = req.params;
        if (!id)
            return sendError(
                res,
                new AppError(400, "MISSING_ID", "Edge ID is required"),
            );

        const { weight, metadata } = req.body as z.infer<typeof UpdateEdgeSchema>;
        // Use effective user ID from body or context - similar to other methods if needed
        const effectiveUserId = getEffectiveUserId(req, undefined);

        const m = new Memory(effectiveUserId);
        // Note: updateEdge was added to Memory/Store in Phase 76, ensure it exists
        await m.temporal.updateEdge(id, effectiveUserId, weight, metadata);

        res.json({
            id,
            message: "Edge updated successfully",
        });
    } catch (error: unknown) {
        logger.error("[TEMPORAL API] Error updating edge:", { error });
        sendError(res, error);
    }
};
