import { q } from "../../core/db";
import { p } from "../../utils";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";

export const usr = (app: Elysia) =>
    app.group("/users", (app) =>
        app
            .get("/:id", async ({ params: { id }, set }) => {
                try {
                    const u = await q.get_user.get(id);
                    if (!u) {
                        set.status = 404;
                        return { err: "nf" };
                    }
                    return {
                        user_id: u.user_id,
                        summary: u.summary,
                        reflection_count: u.reflection_count,
                        created_at: u.created_at,
                        updated_at: u.updated_at,
                    };
                } catch (e: any) {
                    log.error("Get user failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                params: t.Object({ id: t.String() })
            })
            .get("/:id/memories", async ({ params: { id }, query, set }) => {
                try {
                    const l = query.limit ? Number(query.limit) : 20;
                    const o = query.offset ? Number(query.offset) : 0;
                    const m = await q.all_mem_by_user.all(id, l, o);
                    const i = m.map((x: any) => ({
                        id: x.id,
                        content: x.content,
                        tags: p(x.tags),
                        metadata: p(x.meta),
                        created_at: x.created_at,
                        updated_at: x.updated_at,
                        last_seen_at: x.last_seen_at,
                        salience: x.salience,
                        primary_sector: x.primary_sector,
                    }));
                    return { items: i };
                } catch (e: any) {
                    log.error("Get user memories failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                params: t.Object({ id: t.String() }),
                query: t.Object({
                    limit: t.Optional(t.Union([t.String(), t.Numeric()])),
                    offset: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
    );
