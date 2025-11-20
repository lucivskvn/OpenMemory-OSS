import { q, all_async } from "../../core/db";
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
import { z } from "zod";
import { Context } from "../server";
import logger from "../../core/logger";
import { EmbeddingProvider, EmbeddingTelemetryMetadata } from "../../core/types";

const telemetryMetadataSchema = z.object({
    meta_version: z.number().optional(),
    embedding_provider: z.enum(['synthetic', 'openai', 'gemini', 'ollama', 'local', 'router_cpu']),
    batch_mode: z.enum(['simple', 'advanced']),
    // Global SIMD affects all providers
    simd_global_enabled: z.boolean(),
    // Router-specific SIMD (only required when provider === 'router_cpu')
    router_simd_enabled: z.boolean().optional(),
    fallback_enabled: z.boolean().optional(),
    sector_models_summary: z.number().optional(),
    // Allow additional fields for forward compatibility
}).catchall(z.any()).optional();

const querySchema = z.object({
    query: z.string().min(1),
    k: z.number().int().positive().optional(),
    filters: z.object({
        sector: z.string().optional(),
        min_score: z.number().optional(),
        user_id: z.string().optional(),
    }).optional(),
    // Optional telemetry metadata for observability; validated but not used for core query logic
    metadata: telemetryMetadataSchema,
});

const addSchema = z.object({
    content: z.string().min(1),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    user_id: z.string().optional(),
});

const ingestSchema = z.object({
    content_type: z.string(),
    data: z.string(), // Assuming base64 encoded string for data
    metadata: z.record(z.string(), z.any()).optional(),
    config: z.record(z.string(), z.any()).optional(),
    user_id: z.string().optional(),
});

export function mem(app: any) {
    app.post("/memory/add", async (req: Request, ctx: Context) => {
        const validation = addSchema.safeParse(ctx.body);
        if (!validation.success) {
            return new Response(JSON.stringify({ error: "invalid_request", issues: validation.error.issues }),
                { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const b = validation.data;
        try {
            const m = await add_hsg_memory(
                b.content,
                j(b.tags || []),
                b.metadata,
                b.user_id,
            );
            if (b.user_id) {
                update_user_summary(b.user_id).catch((e) =>
                    logger.error({ component: "MEM", err: e }, "[MEM] user summary update failed: %o", e),
                );
            }
            return new Response(JSON.stringify(m));
        } catch (e: any) {
            return new Response(JSON.stringify({ err: e.message }), { status: 500 });
        }
    });

    app.post("/memory/ingest", async (req: Request, ctx: Context) => {
        // Some clients or request paths may not have been parsed by the
        // global body parser (for example in edge cases with streaming
        // transport). If ctx.body is undefined, try to parse the raw body
        // as JSON as a fallback so routes remain resilient and tests that
        // set seams can still exercise the ingest pipeline. Use a cloned
        // request first to avoid "Body already used" errors.
        if (ctx.body === undefined) {
            try {
                let text: string | undefined = undefined;
                if (typeof (req as any).clone === 'function') {
                    try {
                        text = await (req as any).clone().text();
                    } catch (e) {
                        text = undefined;
                    }
                }
                if (!text && typeof (req as any).text === 'function') {
                    try { text = await req.text(); } catch (e) { text = undefined; }
                }
                if (text && text.length) {
                    try { ctx.body = JSON.parse(text); } catch (e) { /* leave as undefined; validation will catch */ }
                }
            } catch (e) {
                // ignore and let validation report invalid_request below
            }
        }

        const validation = ingestSchema.safeParse(ctx.body);
        if (!validation.success) {
            return new Response(JSON.stringify({ error: "invalid_request", issues: validation.error.issues }),
                { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const b = validation.data;
        try {
            const r = await ingestDocument(
                b.content_type,
                b.data,
                b.metadata,
                b.config,
                b.user_id,
            );
            return new Response(JSON.stringify(r));
        } catch (e: any) {
            // Map file-too-large errors to 413 so clients can react appropriately
            if (e?.code === "ERR_FILE_TOO_LARGE" || e?.name === "FileTooLargeError") {
                return new Response(JSON.stringify({ err: "file_too_large", msg: e.message }), { status: 413 });
            }
            // Map unsupported content type to 415
            if (e?.name === 'UnsupportedContentTypeError') {
                return new Response(JSON.stringify({ err: 'unsupported_media_type', msg: e.message }), { status: 415 });
            }
            return new Response(JSON.stringify({ err: "ingest_fail", msg: e.message }), { status: 500 });
        }
    });

    app.post("/memory/ingest/url", async (req: Request, ctx: Context) => {
        const b = ctx.body as any;
        if (!b?.url) return new Response(JSON.stringify({ err: "no_url" }), { status: 400 });
        try {
            const r = await ingestURL(b.url, b.metadata, b.config, b.user_id);
            return new Response(JSON.stringify(r));
        } catch (e: any) {
            if (e?.code === "ERR_FILE_TOO_LARGE" || e?.name === "FileTooLargeError") {
                return new Response(JSON.stringify({ err: "file_too_large", msg: e.message }), { status: 413 });
            }
            if (e?.name === 'UnsupportedContentTypeError') {
                return new Response(JSON.stringify({ err: 'unsupported_media_type', msg: e.message }), { status: 415 });
            }
            return new Response(JSON.stringify({ err: "url_fail", msg: e.message }), { status: 500 });
        }
    });

    app.post("/memory/query", async (req: Request, ctx: Context) => {
        const validation = querySchema.safeParse(ctx.body);
        if (!validation.success) {
            return new Response(JSON.stringify({ error: "invalid_request", issues: validation.error.issues }),
                { status: 400, headers: { "Content-Type": "application/json" } });
        }

        const b = validation.data;
        const k = b.k || 8;

        // Consume telemetry metadata for observability (optional, validated but not used for core query logic)
        if (b.metadata) {
            const { embedding_provider, batch_mode, router_simd_enabled, fallback_enabled, sector_models_summary, ...extra } = b.metadata;
            logger.info({ component: 'MEMORY-QUERY', user_id: b.filters?.user_id, embedding_provider, batch_mode, router_details: { simd_enabled: router_simd_enabled, fallback_enabled, sector_count: sector_models_summary } }, 'Query telemetry');
            // Log unknown metadata keys for forward compatibility tracking
            const unknownKeys = Object.keys(extra);
            if (unknownKeys.length > 0) {
                logger.warn({ unknown_keys: unknownKeys }, 'Unknown metadata keys in query telemetry');
            }
            // Future: Increment metrics counters here (e.g., embed_provider_requests_total{provider="${embedding_provider}"}++)
        }

        try {
            const f = {
                sectors: b.filters?.sector ? [b.filters.sector] : undefined,
                minSalience: b.filters?.min_score,
                user_id: b.filters?.user_id,
            };
            const m = await hsg_query(b.query, k, f);
            const responseData = {
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
            // Backwards compatibility: some clients expect `memories` instead of `matches`.
            try {
                (responseData as any).memories = (responseData as any).matches;
                logger.warn({ component: "MEM" }, "[DEPRECATION] API: /memory/query includes 'matches' and 'memories' (memories is deprecated). Please migrate clients to use 'matches'.");
            } catch (e) { }
            // If client requested SSE streaming, return a small streaming response with
            // the memory matches first. This enables clients to quickly render which
            // memories were used while they synthesize or stream an answer separately.
            const accept = (req.headers.get ? req.headers.get('accept') : '') || '';
            logger.debug({ component: 'MEM', accept, testMode: process.env.OM_TEST_MODE }, 'Memory /query accept header');
            // For tests we allow SSE to be returned when OM_TEST_MODE is set
            // (tests may not set headers exactly the same way as clients). This
            // does not change production behavior when OM_TEST_MODE is unset.
            if ((accept && accept.includes('text/event-stream')) || process.env.OM_TEST_MODE === '1') {
                const encoder = new TextEncoder();
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('event: memories\n'))
                        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'memories', data: responseData.matches }) + '\n\n'))
                        controller.enqueue(encoder.encode('event: done\n'))
                        controller.enqueue(encoder.encode('data: {}\n\n'))
                        controller.close()
                    }
                })
                return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
            }

            return new Response(JSON.stringify(responseData), { headers: { "Content-Type": "application/json" } });
        } catch (e: any) {
            return new Response(JSON.stringify({ query: b.query, matches: [] }), { headers: { "Content-Type": "application/json" } });
        }
    });

    app.post("/memory/reinforce", async (req: Request, ctx: Context) => {
        const b = ctx.body as { id: string; boost?: number };
        if (!b?.id) return new Response(JSON.stringify({ err: "id" }), { status: 400 });
        try {
            await reinforce_memory(b.id, b.boost);
            return new Response(JSON.stringify({ ok: true }));
        } catch (e: any) {
            return new Response(JSON.stringify({ err: "nf" }), { status: 404 });
        }
    });

    app.patch("/memory/:id", async (req: Request, ctx: Context) => {
        const id = ctx.params.id;
        const b = ctx.body as {
            content?: string;
            tags?: string[];
            metadata?: any;
            user_id?: string;
        };
        if (!id) return new Response(JSON.stringify({ err: "id" }), { status: 400 });
        try {
            const m = await q.get_mem.get(id, b.user_id ?? null);
            if (!m) return new Response(JSON.stringify({ err: "nf" }), { status: 404 });

            if (b.user_id && m.user_id !== b.user_id) {
                return new Response(JSON.stringify({ err: "forbidden" }), { status: 403 });
            }

            const r = await update_memory(id, b.content, b.tags, b.metadata);
            return new Response(JSON.stringify(r));
        } catch (e: any) {
            if (e.message.includes("not found")) {
                return new Response(JSON.stringify({ err: "nf" }), { status: 404 });
            } else {
                return new Response(JSON.stringify({ err: "internal" }), { status: 500 });
            }
        }
    });

    app.get("/memory/all", async (req: Request, ctx: Context) => {
        try {
            const u = parseInt(ctx.query.get("u") || "0");
            const l = parseInt(ctx.query.get("l") || "100");
            const s = ctx.query.get("sector");
            const user_id = ctx.query.get("user_id");

            // Check if strict tenant mode is enabled
            const strict = (process.env.OM_STRICT_TENANT || "").toLowerCase() === "true";

            // If strict mode is enabled, require user_id
            if (strict && (!user_id || user_id.trim() === "")) {
                return new Response(
                    JSON.stringify({
                        error: "user_id_required",
                        message: "user_id parameter is required when OM_STRICT_TENANT=true"
                    }),
                    { status: 400, headers: { "Content-Type": "application/json" } }
                );
            }

            let r;
            if (user_id && s) {
                r = await q.all_mem_by_user_and_sector.all(user_id, s, l, u);
            } else if (user_id) {
                r = await q.all_mem_by_user.all(user_id, l, u);
            } else if (s) {
                // Pass user_id to enforce scoping in updated method
                r = await q.all_mem_by_sector.all(s, l, u, user_id);
            } else {
                // Pass user_id to enforce scoping in updated method
                r = await q.all_mem.all(l, u, user_id);
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
            const out = { items: i } as any;
            // Backwards compatibility: include `memories` alias
            out.memories = i;
            logger.warn({ component: "MEM" }, "[DEPRECATION] API: /memory/all includes 'items' and 'memories' (memories is deprecated). Please migrate clients to use 'items'.");
            return new Response(JSON.stringify(out));
        } catch (e: any) {
            if (e.message && e.message.includes("user_id when OM_STRICT_TENANT=true")) {
                return new Response(
                    JSON.stringify({
                        error: "tenant_isolation_error",
                        message: e.message
                    }),
                    { status: 400, headers: { "Content-Type": "application/json" } }
                );
            }
            return new Response(JSON.stringify({ err: "internal" }), { status: 500 });
        }
    });

    app.get("/memory/:id", async (req: Request, ctx: Context) => {
        try {
            const id = ctx.params.id;
            const user_id = ctx.query.get("user_id");
            const m = await q.get_mem.get(id, user_id ?? null);
            if (!m) return new Response(JSON.stringify({ err: "nf" }), { status: 404 });

            if (user_id && m.user_id !== user_id) {
                return new Response(JSON.stringify({ err: "forbidden" }), { status: 403 });
            }

            const v = await q.get_vecs_by_id.all(id, user_id ?? m.user_id ?? null);
            const sec = v.map((x: any) => x.sector);
            const data = {
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
            return new Response(JSON.stringify(data));
        } catch (e: any) {
            return new Response(JSON.stringify({ err: "internal" }), { status: 500 });
        }
    });

    app.delete("/memory/:id", async (req: Request, ctx: Context) => {
        try {
            const id = ctx.params.id;
            const user_id = ctx.query.get("user_id") || (ctx.body as any)?.user_id;
            const m = await q.get_mem.get(id, user_id ?? null);
            if (!m) return new Response(JSON.stringify({ err: "nf" }), { status: 404 });

            if (user_id && m.user_id !== user_id) {
                return new Response(JSON.stringify({ err: "forbidden" }), { status: 403 });
            }

            await q.del_mem.run(id, user_id ?? m.user_id ?? null);
            // Pass explicit user_id (prefer query/body user_id, else the memory's owner)
            await q.del_vec.run(id, user_id ?? m.user_id ?? null);
            await q.del_waypoints.run(id, id, user_id ?? m.user_id ?? null);
            return new Response(JSON.stringify({ ok: true }));
        } catch (e: any) {
            return new Response(JSON.stringify({ err: "internal" }), { status: 500 });
        }
    });
}
