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
import type {
    add_req,
    q_req,
    ingest_req,
    ingest_url_req,
} from "../../core/types";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";

export const mem = (app: Elysia) =>
    app.group("/memory", (app) =>
        app
            .post("/add", async ({ body, set }) => {
                const b = body as add_req;
                if (!b?.content) {
                    set.status = 400;
                    return { err: "content" };
                }
                try {
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
                } catch (e: any) {
                    log.error("Memory add failed", { error: e.message });
                    set.status = 500;
                    return { err: e.message };
                }
            })
            .post("/ingest", async ({ body, set }) => {
                const b = body as ingest_req;
                if (!b?.content_type || !b?.data) {
                    set.status = 400;
                    return { err: "missing" };
                }
                try {
                    return await ingestDocument(
                        b.content_type,
                        b.data,
                        b.metadata,
                        b.config,
                        b.user_id,
                    );
                } catch (e: any) {
                    log.error("Ingest failed", { error: e.message });
                    set.status = 500;
                    return { err: "ingest_fail", msg: e.message };
                }
            })
            .post("/ingest/url", async ({ body, set }) => {
                const b = body as ingest_url_req;
                if (!b?.url) {
                    set.status = 400;
                    return { err: "no_url" };
                }
                try {
                    return await ingestURL(b.url, b.metadata, b.config, b.user_id);
                } catch (e: any) {
                    log.error("URL ingest failed", { error: e.message });
                    set.status = 500;
                    return { err: "url_fail", msg: e.message };
                }
            })
            .post("/query", async ({ body, set }) => {
                const b = body as q_req;
                const k = b.k || 8;
                try {
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
                        })),
                    };
                } catch (e: any) {
                    log.error("Query failed", { error: e.message });
                    return { query: b.query, matches: [] };
                }
            })
            .post("/reinforce", async ({ body, set }) => {
                const b = body as { id: string; boost?: number };
                if (!b?.id) {
                    set.status = 400;
                    return { err: "id" };
                }
                try {
                    await reinforce_memory(b.id, b.boost);
                    return { ok: true };
                } catch (e: any) {
                    set.status = 404;
                    return { err: "nf" };
                }
            })
            .patch("/:id", async ({ params: { id }, body, set }) => {
                const b = body as {
                    content?: string;
                    tags?: string[];
                    metadata?: any;
                    user_id?: string;
                };
                if (!id) {
                    set.status = 400;
                    return { err: "id" };
                }
                try {
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
                } catch (e: any) {
                    if (e.message.includes("not found")) {
                        set.status = 404;
                        return { err: "nf" };
                    } else {
                        log.error("Update memory failed", { error: e.message });
                        set.status = 500;
                        return { err: "internal" };
                    }
                }
            })
            .get("/all", async ({ query, set }) => {
                try {
                    const u = query.u ? parseInt(query.u as string) : 0;
                    const l = query.l ? parseInt(query.l as string) : 100;
                    const s = query.sector as string;
                    const user_id = query.user_id as string;

                    let r;
                    if (user_id) {
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
                } catch (e: any) {
                    log.error("Get all memories failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
            .get("/:id", async ({ params: { id }, query, set }) => {
                try {
                    const user_id = query.user_id as string;
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
                } catch (e: any) {
                    log.error("Get memory failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
            .delete("/:id", async ({ params: { id }, query, body, set }) => {
                try {
                    const b = body as { user_id?: string };
                    const user_id = (query.user_id as string) || b?.user_id;
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
                } catch (e: any) {
                    log.error("Delete memory failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
    );
