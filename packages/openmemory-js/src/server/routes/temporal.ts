import { insert_fact, update_fact, invalidate_fact, delete_fact, apply_confidence_decay, get_active_facts_count, get_total_facts_count, insert_edge, invalidate_edge } from '../../temporal_graph/store'
import { query_facts_at_time, get_current_fact, query_facts_in_range, search_facts, get_facts_by_subject, get_related_facts, query_edges } from '../../temporal_graph/query'
import { get_subject_timeline, get_predicate_timeline, get_changes_in_window, compare_time_points, get_change_frequency, get_volatile_facts } from '../../temporal_graph/timeline'
import { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import { z } from 'zod'

const FactSchema = z.object({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    object: z.string().min(1),
    valid_from: z.string().or(z.number()).optional(),
    confidence: z.number().min(0).max(1).optional().default(1.0),
    metadata: z.record(z.any()).optional()
})

const QueryFactSchema = z.object({
    subject: z.string().optional(),
    predicate: z.string().optional(),
    object: z.string().optional(),
    at: z.string().or(z.number()).optional(),
    min_confidence: z.string().or(z.number()).optional().default(0.1)
})

export const create_temporal_fact = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = FactSchema.safeParse(req.body)
        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid fact data', validated.error.format()));
        }

        const { subject, predicate, object, valid_from, confidence, metadata } = validated.data
        const user_id = req.user?.id

        const valid_from_date = valid_from ? new Date(valid_from) : new Date()

        const id = await insert_fact(subject, predicate, object, valid_from_date, confidence, metadata, user_id)

        res.json({
            id,
            subject,
            predicate,
            object,
            valid_from: valid_from_date.toISOString(),
            confidence,
            message: 'Fact created successfully'
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error creating fact:', error)
        sendError(res, error);
    }
}


export const get_temporal_fact = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = QueryFactSchema.safeParse(req.query)
        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid query parameters', validated.error.format()));
        }

        const { subject, predicate, object, at, min_confidence } = validated.data

        if (!subject && !predicate && !object) {
            return sendError(res, new AppError(400, "MISSING_QUERY", 'At least one of subject, predicate, or object is required'));
        }

        const at_date = at ? new Date(at) : new Date()
        const min_conf = typeof min_confidence === 'string' ? parseFloat(min_confidence) : min_confidence

        const facts = await query_facts_at_time(subject, predicate, object, at_date, min_conf, req.user?.id)

        res.json({
            facts,
            query: { subject, predicate, object, at: at_date.toISOString(), min_confidence: min_conf },
            count: facts.length
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error querying facts:', error)
        sendError(res, error);
    }
}


export const get_current_temporal_fact = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = z.object({
            subject: z.string().min(1),
            predicate: z.string().min(1)
        }).safeParse(req.query)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Subject and predicate are required', validated.error.format()));
        }

        const { subject, predicate } = validated.data

        const fact = await get_current_fact(subject, predicate, req.user?.id)

        if (!fact) {
            return sendError(res, new AppError(404, "NOT_FOUND", 'No current fact found', { subject, predicate }));
        }

        res.json({ fact })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error getting current fact:', error)
        sendError(res, error);
    }
}


export const get_entity_timeline = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = z.object({
            subject: z.string().min(1),
            predicate: z.string().optional()
        }).safeParse(req.query)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Subject is required', validated.error.format()));
        }

        const { subject, predicate } = validated.data

        const timeline = await get_subject_timeline(subject, predicate, req.user?.id)

        res.json({
            subject,
            predicate,
            timeline,
            count: timeline.length
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error getting timeline:', error)
        sendError(res, error);
    }
}


export const get_predicate_history = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = z.object({
            predicate: z.string().min(1),
            from: z.string().or(z.number()).optional(),
            to: z.string().or(z.number()).optional()
        }).safeParse(req.query)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Predicate is required', validated.error.format()));
        }

        const { predicate, from, to } = validated.data

        const from_date = from ? new Date(from) : undefined
        const to_date = to ? new Date(to) : undefined

        const timeline = await get_predicate_timeline(predicate, from_date, to_date, req.user?.id)

        res.json({
            predicate,
            from: from_date?.toISOString(),
            to: to_date?.toISOString(),
            timeline,
            count: timeline.length
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error getting predicate timeline:', error)
        sendError(res, error);
    }
}


export const update_temporal_fact = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const { id } = req.params
        if (!id) return sendError(res, new AppError(400, "MISSING_ID", 'Fact ID is required'));

        const validated = z.object({
            confidence: z.number().min(0).max(1).optional(),
            metadata: z.record(z.any()).optional()
        }).safeParse(req.body)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid update data', validated.error.format()));
        }

        const { confidence, metadata } = validated.data
        const user_id = req.user?.id

        if (confidence === undefined && metadata === undefined) {
            return sendError(res, new AppError(400, "MISSING_UPDATE_DATA", 'At least one of confidence or metadata must be provided'));
        }

        await update_fact(id, user_id, confidence, metadata)

        res.json({ id, confidence, metadata, message: 'Fact updated successfully' })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error updating fact:', error)
        sendError(res, error);
    }
}


export const invalidate_temporal_fact = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const { id } = req.params
        if (!id) return sendError(res, new AppError(400, "MISSING_ID", 'Fact ID is required'));

        const validated = z.object({
            valid_to: z.string().or(z.number()).optional()
        }).safeParse(req.body)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid invalidation data', validated.error.format()));
        }

        const { valid_to } = validated.data
        const user_id = req.user?.id

        const valid_to_date = valid_to ? new Date(valid_to) : new Date()

        await invalidate_fact(id, user_id, valid_to_date)

        res.json({ id, valid_to: valid_to_date.toISOString(), message: 'Fact invalidated successfully' })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error invalidating fact:', error)
        sendError(res, error);
    }
}


export const get_subject_facts = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const { subject } = req.params
        if (!subject) return sendError(res, new AppError(400, "MISSING_SUBJECT", 'Subject parameter is required'));

        const validated = z.object({
            at: z.string().or(z.number()).optional(),
            include_historical: z.string().or(z.boolean()).optional()
        }).safeParse(req.query)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid query parameters', validated.error.format()));
        }

        const { at, include_historical } = validated.data
        const at_date = at ? new Date(at) : undefined
        const include_hist = include_historical === 'true' || include_historical === true

        const facts = await get_facts_by_subject(subject, at_date, include_hist, req.user?.id)

        res.json({
            subject,
            at: at_date?.toISOString(),
            include_historical: include_hist,
            facts,
            count: facts.length
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error getting subject facts:', error)
        sendError(res, error);
    }
}


export const search_temporal_facts = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = z.object({
            pattern: z.string().min(1),
            field: z.enum(['subject', 'predicate', 'object']).optional().default('subject'),
            at: z.string().or(z.number()).optional(),
            limit: z.string().or(z.number()).optional()
        }).safeParse(req.query)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid search parameters', validated.error.format()));
        }

        const { pattern, field, at, limit } = validated.data
        const at_date = at ? new Date(at) : undefined
        const limit_val = limit ? (typeof limit === 'string' ? parseInt(limit) : limit) : 100

        const facts = await search_facts(pattern, field, at_date, limit_val, req.user?.id)

        res.json({
            pattern,
            field,
            at: at_date?.toISOString(),
            facts,
            count: facts.length
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error searching facts:', error)
        sendError(res, error);
    }
}


export const get_temporal_stats = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const active_facts = await get_active_facts_count(req.user?.id)
        const total_facts = await get_total_facts_count(req.user?.id)
        const historical_facts = total_facts - active_facts

        res.json({
            active_facts,
            historical_facts,
            total_facts,
            historical_percentage: total_facts > 0 ? ((historical_facts / total_facts) * 100).toFixed(2) + '%' : '0%'
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error getting stats:', error)
        sendError(res, error);
    }
}


export const apply_decay = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const { decay_rate = 0.01 } = req.body

        const updated = await apply_confidence_decay(decay_rate, req.user?.id)

        res.json({
            decay_rate,
            facts_updated: updated,
            message: 'Confidence decay applied successfully'
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error applying decay:', error)
        sendError(res, error);
    }
}


const CompareSchema = z.object({
    subject: z.string().min(1),
    time1: z.string().or(z.number()),
    time2: z.string().or(z.number())
})

export const compare_facts = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = CompareSchema.safeParse(req.query)
        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Subject, time1, and time2 are required', validated.error.format()));
        }

        const { subject, time1, time2 } = validated.data
        const t1 = new Date(time1)
        const t2 = new Date(time2)

        const comparison = await compare_time_points(subject, t1, t2, req.user?.id)

        res.json({
            subject,
            time1: t1.toISOString(),
            time2: t2.toISOString(),
            ...comparison,
            summary: {
                added: comparison.added.length,
                removed: comparison.removed.length,
                changed: comparison.changed.length,
                unchanged: comparison.unchanged.length
            }
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error comparing facts:', error)
        sendError(res, error);
    }
}


export const get_most_volatile = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = z.object({
            subject: z.string().optional(),
            limit: z.string().or(z.number()).optional().default(10)
        }).safeParse(req.query)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid query parameters', validated.error.format()));
        }

        const { subject, limit } = validated.data
        const lim_val = typeof limit === 'string' ? parseInt(limit) : limit

        const volatile = await get_volatile_facts(subject, lim_val, req.user?.id)

        res.json({
            subject,
            limit: lim_val,
            volatile_facts: volatile,
            count: volatile.length
        })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error getting volatile facts:', error)
        sendError(res, error);
    }
}

export const create_temporal_edge = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = z.object({
            source_id: z.string().min(1),
            target_id: z.string().min(1),
            relation_type: z.string().min(1),
            valid_from: z.string().or(z.number()).optional(),
            weight: z.number().min(0).max(1).optional().default(1.0),
            metadata: z.record(z.any()).optional()
        }).safeParse(req.body)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid edge data', validated.error.format()));
        }

        const { source_id, target_id, relation_type, valid_from, weight, metadata } = validated.data
        const user_id = req.user?.id

        const valid_from_date = valid_from ? new Date(valid_from) : new Date()

        const id = await insert_edge(source_id, target_id, relation_type, valid_from_date, weight, metadata, user_id)

        res.json({ id, source_id, target_id, relation_type, weight, message: 'Edge created successfully' })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error creating edge:', error)
        sendError(res, error);
    }
}

export const get_temporal_edges = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const validated = z.object({
            source_id: z.string().optional(),
            target_id: z.string().optional(),
            relation_type: z.string().optional(),
            at: z.string().or(z.number()).optional()
        }).safeParse(req.query)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid query parameters', validated.error.format()));
        }

        const { source_id, target_id, relation_type, at } = validated.data
        const user_id = req.user?.id
        const at_date = at ? new Date(at) : new Date()

        const edges = await query_edges(source_id, target_id, relation_type, at_date, user_id)

        res.json({ edges, count: edges.length })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error querying edges:', error)
        sendError(res, error);
    }
}

export const invalidate_temporal_edge = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const { id } = req.params
        if (!id) return sendError(res, new AppError(400, "MISSING_ID", 'Edge ID is required'));

        const validated = z.object({
            valid_to: z.string().or(z.number()).optional()
        }).safeParse(req.body)

        if (!validated.success) {
            return sendError(res, new AppError(400, "VALIDATION_ERROR", 'Invalid invalidation data', validated.error.format()));
        }

        const { valid_to } = validated.data
        const user_id = req.user?.id

        const valid_to_date = valid_to ? new Date(valid_to) : new Date()

        await invalidate_edge(id, user_id, valid_to_date)

        res.json({ id, valid_to: valid_to_date.toISOString(), message: 'Edge invalidated successfully' })
    } catch (error: unknown) {
        console.error('[TEMPORAL API] Error invalidating edge:', error)
        sendError(res, error);
    }
}

export function temporal(app: any) {
    app.post('/api/temporal/fact', create_temporal_fact)
    app.get('/api/temporal/fact', get_temporal_fact)
    app.get('/api/temporal/fact/current', get_current_temporal_fact)
    app.patch('/api/temporal/fact/:id', update_temporal_fact)
    app.delete('/api/temporal/fact/:id', invalidate_temporal_fact)

    app.get('/api/temporal/timeline', get_entity_timeline)
    app.get('/api/temporal/history/predicate', get_predicate_history)
    app.get('/api/temporal/subject/:subject', get_subject_facts)
    app.get('/api/temporal/search', search_temporal_facts)
    app.get('/api/temporal/compare', compare_facts)
    app.get('/api/temporal/stats', get_temporal_stats)
    app.post('/api/temporal/decay', apply_decay)
    app.get('/api/temporal/volatile', get_most_volatile)

    app.post('/api/temporal/edge', create_temporal_edge)
    app.get('/api/temporal/edge', get_temporal_edges)
    app.delete('/api/temporal/edge/:id', invalidate_temporal_edge)
}
