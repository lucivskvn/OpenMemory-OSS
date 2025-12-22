import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import { create_fact, get_facts } from "../../memory/temporal";

export const temporal = (app: Elysia) =>
    app.group("/temporal", (app) =>
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
                    subject: t.String(),
                    predicate: t.String(),
                    object: t.String(),
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
    );
