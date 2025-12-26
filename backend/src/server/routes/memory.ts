import { q, vector_store } from "../../core/db";
import { j, p } from "../../utils";
import {
    add_hsg_memory,
    hsg_query,
    reinforce_memory,
    update_memory,
} from "../../memory/hsg";
import { ingestDocument, ingestURL } from "../../ops/ingest";
import { update_user_summary } from "../../memory/user_summary";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";

export const mem = (app: Elysia) =>
    app
        .post("/api/memory/add", async ({ body }) => {
            const b = body;
            const m = await add_hsg_memory(
                b.content,
                j(b.tags || []),
                b.metadata,
                b.user_id,
            );

            if (b.user_id) {
                update_user_summary(b.user_id).catch((e) =>
                    log.error("[mem] user summary update failed", e),
                );
            }
            return m;
        }, {
            body: t.Object({
                content: t.String({ minLength: 1 }),
                tags: t.Optional(t.Array(t.String())),
                metadata: t.Optional(t.Any()),
                salience: t.Optional(t.Numeric()),
                decay_lambda: t.Optional(t.Numeric()),
                user_id: t.Optional(t.String())
            })
        })
        .get("/api/memory/sectors", async () => {
            return {
                sectors: [
                    "episodic",
                    "semantic",
                    "procedural",
                    "emotional",
                    "reflective",
                ]
            };
        })
        .post("/api/memory/ingest", async ({ body }) => {
            const b = body;
            return await ingestDocument(
                b.content_type,
                b.data,
                b.metadata,
                b.config,
                b.user_id,
            );
        }, {
            body: t.Object({
                source: t.Union([t.Literal("file"), t.Literal("link"), t.Literal("connector")]),
                content_type: t.Union([t.Literal("pdf"), t.Literal("docx"), t.Literal("html"), t.Literal("md"), t.Literal("txt"), t.Literal("audio")]),
                data: t.String(),
                metadata: t.Optional(t.Any()),
                config: t.Optional(t.Object({
                    force_root: t.Optional(t.Boolean()),
                    sec_sz: t.Optional(t.Numeric()),
                    lg_thresh: t.Optional(t.Numeric())
                })),
                user_id: t.Optional(t.String())
            })
        })
        .post("/api/memory/ingest/url", async ({ body }) => {
            const b = body;
            return await ingestURL(b.url, b.metadata, b.config, b.user_id);
        }, {
            body: t.Object({
                url: t.String(),
                metadata: t.Optional(t.Any()),
                config: t.Optional(t.Object({
                    force_root: t.Optional(t.Boolean()),
                    sec_sz: t.Optional(t.Numeric()),
                    lg_thresh: t.Optional(t.Numeric())
                })),
                user_id: t.Optional(t.String())
            })
        })
        .post("/api/memory/query", async ({ body }) => {
            const b = body;
            const k = b.k || 8;
            const f = {
                sectors: b.filters?.sector ? [b.filters.sector] : undefined,
                minSalience: b.filters?.min_score,
                user_id: b.filters?.user_id || b.user_id,
            };
            const m = await hsg_query(b.query, k, f);
            return {
                query: b.query,
                matches: m.map((x: any) => ({
                    id: x.id,
                    content: x.content,
                    score: x.score,
                    sectors: x.sectors,
                    primary_sector: x.primary_sector,
                    path: x.path,
                    salience: x.salience,
                    last_seen_at: x.last_seen_at,
                    created_at: x.created_at,
                })),
            };
        }, {
            body: t.Object({
                query: t.String(),
                k: t.Optional(t.Numeric()),
                filters: t.Optional(t.Object({
                    tags: t.Optional(t.Array(t.String())),
                    min_score: t.Optional(t.Numeric()),
                    sector: t.Optional(t.String()),
                    user_id: t.Optional(t.String())
                })),
                user_id: t.Optional(t.String())
            })
        })
        .post("/api/memory/reinforce", async ({ body, set }) => {
            const b = body;
            try {
                await reinforce_memory(b.id, b.boost);
                return { ok: true };
            } catch (e: any) {
                set.status = 404;
                return { err: "nf" };
            }
        }, {
            body: t.Object({
                id: t.String(),
                boost: t.Optional(t.Numeric())
            })
        })
        .patch("/api/memory/:id", async ({ params: { id }, body, set }) => {
            const b = body;
            const m = await q.get_mem.get(id);
            if (!m) {
                set.status = 404;
                return { err: "nf" };
            }

            if (b.user_id && m.user_id !== b.user_id) {
                set.status = 403;
                return { err: "forbidden" };
            }

            return await update_memory(id, b.content, b.tags, b.metadata);
        }, {
            params: t.Object({ id: t.String() }),
            body: t.Object({
                content: t.Optional(t.String()),
                tags: t.Optional(t.Array(t.String())),
                metadata: t.Optional(t.Any()),
                user_id: t.Optional(t.String())
            })
        })
        .get("/api/memory/all", async ({ query }) => {
            const u = query.u ? Number(query.u) : 0;
            const l = query.l ? Number(query.l) : 100;
            const s = query.sector;
            const user_id = query.user_id;

            let r;
            if (user_id && s) {
                r = await q.all_mem_by_sector_user.all(s, user_id, l, u);
            } else if (user_id) {
                r = await q.all_mem_by_user.all(user_id, l, u);
            } else if (s) {
                r = await q.all_mem_by_sector.all(s, l, u);
            } else {
                r = await q.all_mem.all(l, u);
            }

            const i = r.map((x: any) => ({
                id: x.id,
                content: x.content,
                tags: p(x.tags),
                metadata: p(x.meta),
                created_at: x.created_at,
                updated_at: x.updated_at,
                last_seen_at: x.last_seen_at,
                salience: x.salience,
                decay_lambda: x.decay_lambda,
                primary_sector: x.primary_sector,
                version: x.version,
                user_id: x.user_id,
            }));
            return { items: i };
        }, {
            query: t.Object({
                u: t.Optional(t.Union([t.String(), t.Numeric()])),
                l: t.Optional(t.Union([t.String(), t.Numeric()])),
                sector: t.Optional(t.String()),
                user_id: t.Optional(t.String())
            })
        })
        .get("/api/memory/:id", async ({ params: { id }, query, set }) => {
            const user_id = query.user_id;
            const m = await q.get_mem.get(id);
            if (!m) {
                set.status = 404;
                return { err: "nf" };
            }

            if (user_id && m.user_id !== user_id) {
                set.status = 403;
                return { err: "forbidden" };
            }

            const v = await vector_store.getVectorsById(id);
            const sec = v.map((x: any) => x.sector);
            return {
                id: m.id,
                content: m.content,
                primary_sector: m.primary_sector,
                sectors: sec,
                tags: p(m.tags),
                metadata: p(m.meta),
                created_at: m.created_at,
                updated_at: m.updated_at,
                last_seen_at: m.last_seen_at,
                salience: m.salience,
                decay_lambda: m.decay_lambda,
                version: m.version,
                user_id: m.user_id,
            };
        }, {
            params: t.Object({ id: t.String() }),
            query: t.Object({
                user_id: t.Optional(t.String())
            })
        })
        .delete("/api/memory/:id", async ({ params: { id }, query, body, set }) => {
            const b = body;
            const user_id = query.user_id || b?.user_id;
            const m = await q.get_mem.get(id);
            if (!m) {
                set.status = 404;
                return { err: "nf" };
            }

            if (user_id && m.user_id !== user_id) {
                set.status = 403;
                return { err: "forbidden" };
            }

            await q.del_mem.run(id);
            await vector_store.deleteVectors(id);
            await q.del_waypoints.run(id, id);
            return { ok: true };
        }, {
            params: t.Object({ id: t.String() }),
            query: t.Object({
                user_id: t.Optional(t.String())
            }),
            body: t.Optional(t.Object({
                user_id: t.Optional(t.String())
            }))
        });
