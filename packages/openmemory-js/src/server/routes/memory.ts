import { q, vector_store } from "../../core/db";
import { get_encryption } from "../../core/security";
import { now, rid, j, p } from "../../utils";
import {
    add_hsg_memory,
    hsg_query,
    reinforce_memory,
    update_memory,
} from "../../memory/hsg";
import { ingestDocument, ingestURL } from "../../ops/ingest";
import { env } from "../../core/cfg";
import { update_user_summary } from "../../memory/user_summary";
import { MemoryRow } from "../../core/types";
import { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import { z } from "zod";

const AddMemorySchema = z.object({
    content: z.string().min(1),
    tags: z.array(z.string()).optional().default([]),
    metadata: z.record(z.any()).optional().default({})
});

const IngestSchema = z.object({
    content_type: z.string().min(1),
    data: z.any(),
    metadata: z.record(z.any()).optional().default({}),
    config: z.record(z.any()).optional().default({})
});

const IngestUrlSchema = z.object({
    url: z.string().url(),
    metadata: z.record(z.any()).optional().default({}),
    config: z.record(z.any()).optional().default({})
});

const QueryMemorySchema = z.object({
    query: z.string().min(1),
    k: z.number().optional().default(8),
    filters: z.object({
        sector: z.string().optional(),
        min_score: z.number().optional(),
        user_id: z.string().optional(),
        startTime: z.string().or(z.number()).optional(),
        endTime: z.string().or(z.number()).optional()
    }).optional()
});

export function mem(app: any) {
    app.post("/memory/add", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = AddMemorySchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid memory data", validated.error.format()));
            }

            const { content, tags, metadata } = validated.data;
            const user_id = req.user?.id;

            const m = await add_hsg_memory(
                content,
                j(tags),
                metadata,
                user_id,
            );
            res.json(m);

            if (user_id) {
                update_user_summary(user_id).catch((e) =>
                    console.error("[mem] user summary update failed:", e),
                );
            }
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    app.post("/memory/ingest", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = IngestSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid ingestion data", validated.error.format()));
            }

            const { content_type, data, metadata, config } = validated.data;
            const user_id = req.user?.id;

            const r = await ingestDocument(
                content_type,
                data,
                metadata,
                config,
                user_id,
            );
            res.json(r);
        } catch (e: unknown) {
            sendError(res, new AppError(500, "INGEST_FAILED", "Ingestion failed", e instanceof Error ? e.message : String(e)));
        }
    });

    app.post("/memory/ingest/url", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = IngestUrlSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid URL ingestion data", validated.error.format()));
            }

            const { url, metadata, config } = validated.data;
            const user_id = req.user?.id;

            const r = await ingestURL(url, metadata, config, user_id);
            res.json(r);
        } catch (e: unknown) {
            sendError(res, new AppError(500, "URL_INGEST_FAILED", "URL ingestion failed", e instanceof Error ? e.message : String(e)));
        }
    });

    app.post("/memory/query", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = QueryMemorySchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid query data", validated.error.format()));
            }

            const { query, k, filters } = validated.data;
            const user_id = req.user?.id || filters?.user_id;

            const f = {
                sectors: filters?.sector ? [filters.sector] : undefined,
                minSalience: filters?.min_score,
                user_id,
                startTime: filters?.startTime ? new Date(filters.startTime) : undefined,
                endTime: filters?.endTime ? new Date(filters.endTime) : undefined,
            };

            const m = await hsg_query(query, k, f);
            res.json({
                query,
                matches: m.map((x) => ({
                    id: x.id,
                    content: x.content,
                    score: x.score,
                    sectors: x.sectors,
                    primary_sector: x.primary_sector,
                    path: x.path,
                    salience: x.salience,
                    last_seen_at: x.last_seen_at,
                })),
            });
        } catch (e: unknown) {
            console.error("[query] error:", e);
            res.json({ query: req.body.query || "", matches: [] });
        }
    });

    app.post("/memory/reinforce", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = z.object({
                id: z.string().min(1),
                boost: z.number().optional()
            }).safeParse(req.body);

            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "ID is required", validated.error.format()));
            }

            const { id, boost } = validated.data;
            await reinforce_memory(id, boost, req.user?.id);
            res.json({ ok: true });
        } catch (e: unknown) {
            sendError(res, new AppError(404, "NOT_FOUND", "Memory not found for reinforcement"));
        }
    });

    app.patch("/memory/:id", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const id = req.params.id;
            const user_id = req.user?.id;
            if (!id) return sendError(res, new AppError(400, "MISSING_ID", "ID is required"));

            const validated = z.object({
                content: z.string().optional(),
                tags: z.array(z.string()).optional(),
                metadata: z.record(z.any()).optional()
            }).safeParse(req.body);

            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid update data", validated.error.format()));
            }

            const { content, tags, metadata } = validated.data;

            const m = await q.get_mem.get(id, user_id);
            if (!m) return sendError(res, new AppError(404, "NOT_FOUND", "Memory not found"));

            const r = await update_memory(id, content, tags, metadata, user_id);
            res.json(r);
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    app.get("/memory/all", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = z.object({
                u: z.string().or(z.number()).optional().default(0),
                l: z.string().or(z.number()).optional().default(100),
                sector: z.string().optional(),
                user_id: z.string().optional()
            }).safeParse(req.query);

            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid query parameters", validated.error.format()));
            }

            const u = typeof validated.data.u === 'string' ? parseInt(validated.data.u) : validated.data.u;
            const l = typeof validated.data.l === 'string' ? parseInt(validated.data.l) : validated.data.l;
            const s = validated.data.sector;
            const user_id = req.user?.id || validated.data.user_id;

            let r;
            if (user_id) {
                r = await q.all_mem_by_user.all(user_id, l, u);
            } else if (s) {
                r = await q.all_mem_by_sector.all(s, l, u);
            } else {
                r = await q.all_mem.all(l, u);
            }

            const enc = get_encryption();
            const i = await Promise.all(r.map(async (x: MemoryRow) => ({
                id: x.id,
                content: await enc.decrypt(x.content),
                tags: p(x.tags || "[]"),
                metadata: p(x.meta || "{}"),
                created_at: x.created_at,
                updated_at: x.updated_at,
                last_seen_at: x.last_seen_at,
                salience: x.salience,
                decay_lambda: x.decay_lambda,
                primary_sector: x.primary_sector,
                version: x.version,
                user_id: x.user_id,
            })));
            res.json({ items: i });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    app.get("/memory/:id", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const id = req.params.id;
            const user_id = req.user?.id;
            const m = await q.get_mem.get(id, user_id);
            if (!m) return sendError(res, new AppError(404, "NOT_FOUND", "Memory not found"));

            const v = await vector_store.getVectorsById(id);
            const sec = v.map((x: { sector: string }) => x.sector);
            const enc = get_encryption();
            res.json({
                id: m.id,
                content: await enc.decrypt(m.content),
                primary_sector: m.primary_sector,
                sectors: sec,
                tags: p(m.tags || "[]"),
                metadata: p(m.meta || "{}"),
                created_at: m.created_at,
                updated_at: m.updated_at,
                last_seen_at: m.last_seen_at,
                salience: m.salience,
                decay_lambda: m.decay_lambda,
                version: m.version,
                user_id: m.user_id,
            });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });

    app.delete("/memory/:id", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const id = req.params.id;
            const user_id = req.user?.id;
            const m = await q.get_mem.get(id, user_id);
            if (!m) return sendError(res, new AppError(404, "NOT_FOUND", "Memory not found"));

            await q.del_mem.run(id, user_id);
            res.json({ ok: true });
        } catch (e: unknown) {
            sendError(res, e);
        }
    });
}
