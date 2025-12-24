import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import {
    create_fact, get_facts, create_edge, get_edges, get_related_facts,
    search_facts, get_subject_timeline, get_changes_in_window,
    get_change_frequency, compare_time_points, get_volatile_facts,
    invalidate_fact
} from "../../memory/temporal";

export const temporal = (app: Elysia) =>
    app.group("/api/temporal", (app) =>
        app
            .post("/fact", async ({ body, set }) => {
                const b = body;
                try {
                    const id = await create_fact(
                        b.subject,
                        b.predicate,
                        b.object,
                        b.valid_from,
                        b.valid_to,
                        b.confidence,
                        b.metadata
                    );
                    return { ok: true, id };
                } catch (error: any) {
                    log.error('Temporal fact creation failed', { error: error.message });
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                body: t.Object({
                    subject: t.String({ minLength: 1 }),
                    predicate: t.String({ minLength: 1 }),
                    object: t.String({ minLength: 1 }),
                    valid_from: t.Optional(t.Numeric()),
                    valid_to: t.Optional(t.Numeric()),
                    confidence: t.Optional(t.Numeric()),
                    metadata: t.Optional(t.Any())
                })
            })
            .get("/fact", async ({ query, set }) => {
                try {
                    const filters = {
                        subject: query.subject,
                        predicate: query.predicate,
                        object: query.object,
                        valid_at: query.valid_at ? Number(query.valid_at) : undefined
                    };
                    const facts = await get_facts(filters);
                    return { facts };
                } catch (error: any) {
                    log.error('Temporal fact query failed', { error: error.message });
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    subject: t.Optional(t.String()),
                    predicate: t.Optional(t.String()),
                    object: t.Optional(t.String()),
                    valid_at: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            .delete("/fact/:id", async ({ params, query, set }) => {
                try {
                    await invalidate_fact(params.id, query.valid_to ? Number(query.valid_to) : undefined);
                    return { ok: true };
                } catch (error: any) {
                    log.error('Temporal fact invalidation failed', { error: error.message });
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                params: t.Object({
                    id: t.String()
                }),
                query: t.Object({
                    valid_to: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            .post("/edge", async ({ body, set }) => {
                const b = body;
                try {
                    const id = await create_edge(
                        b.source_id,
                        b.target_id,
                        b.relation,
                        b.weight,
                        b.metadata
                    );
                    return { ok: true, id };
                } catch (error: any) {
                    log.error('Temporal edge creation failed', { error: error.message });
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                body: t.Object({
                    source_id: t.String(),
                    target_id: t.String(),
                    relation: t.String(),
                    weight: t.Optional(t.Numeric()),
                    metadata: t.Optional(t.Any())
                })
            })
            .get("/edge", async ({ query, set }) => {
                try {
                    const edges = await get_edges(query.source_id);
                    return { edges };
                } catch (error: any) {
                    log.error('Temporal edge query failed', { error: error.message });
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    source_id: t.String()
                })
            })
            .get("/related", async ({ query, set }) => {
                try {
                    const related = await get_related_facts(
                        query.fact_id,
                        query.relation_type,
                        query.at ? Number(query.at) : undefined
                    );
                    return { related };
                } catch (error: any) {
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    fact_id: t.String(),
                    relation_type: t.Optional(t.String()),
                    at: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            .get("/search", async ({ query, set }) => {
                try {
                    const facts = await search_facts(
                        query.pattern,
                        query.field as any,
                        query.at ? Number(query.at) : undefined
                    );
                    return { facts };
                } catch (error: any) {
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    pattern: t.String(),
                    field: t.Optional(t.String()),
                    at: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            .get("/timeline", async ({ query, set }) => {
                try {
                    const timeline = await get_subject_timeline(query.subject, query.predicate);
                    return { timeline };
                } catch (error: any) {
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    subject: t.String(),
                    predicate: t.Optional(t.String())
                })
            })
            .get("/changes", async ({ query, set }) => {
                try {
                    const timeline = await get_changes_in_window(
                        Number(query.start),
                        Number(query.end),
                        query.subject
                    );
                    return { timeline };
                } catch (error: any) {
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    start: t.Union([t.String(), t.Numeric()]),
                    end: t.Union([t.String(), t.Numeric()]),
                    subject: t.Optional(t.String())
                })
            })
            .get("/frequency", async ({ query, set }) => {
                try {
                    const result = await get_change_frequency(
                        query.subject,
                        query.predicate,
                        query.window_days ? Number(query.window_days) : undefined
                    );
                    return { result };
                } catch (error: any) {
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    subject: t.String(),
                    predicate: t.String(),
                    window_days: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            .get("/compare", async ({ query, set }) => {
                try {
                    const result = await compare_time_points(
                        query.subject,
                        Number(query.time1),
                        Number(query.time2)
                    );
                    return { result };
                } catch (error: any) {
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    subject: t.String(),
                    time1: t.Union([t.String(), t.Numeric()]),
                    time2: t.Union([t.String(), t.Numeric()])
                })
            })
            .get("/volatile", async ({ query, set }) => {
                try {
                    const result = await get_volatile_facts(
                        query.subject,
                        query.limit ? Number(query.limit) : undefined
                    );
                    return { result };
                } catch (error: any) {
                    set.status = 500;
                    return { error: error.message };
                }
            }, {
                query: t.Object({
                    subject: t.Optional(t.String()),
                    limit: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
    );
