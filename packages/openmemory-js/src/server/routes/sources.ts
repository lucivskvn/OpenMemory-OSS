/**
 * sources webhook routes - ingest data from external sources via HTTP
 * 
 * POST /sources/:source/ingest
 *   body: { creds: {...}, filters: {...}, user_id?: string }
 * 
 * POST /sources/webhook/:source
 *   generic webhook endpoint for source-specific payloads
 */

import * as sources from "../../sources";
import { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import { z } from "zod";

const IngestSchema = z.object({
    creds: z.record(z.any()).optional().default({}),
    filters: z.record(z.any()).optional().default({}),
    user_id: z.string().optional()
});

const GithubWebhookSchema = z.object({
    commits: z.array(z.any()).optional(),
    repository: z.object({ full_name: z.string().optional() }).optional(),
    ref: z.string().optional(),
    action: z.string().optional(),
    issue: z.object({ title: z.string().optional(), body: z.string().optional(), number: z.number().optional() }).optional(),
    pull_request: z.object({ title: z.string().optional(), body: z.string().optional(), number: z.number().optional() }).optional(),
}).passthrough();

export function src(app: any) {
    // list available sources
    app.get("/sources", async (req: AdvancedRequest, res: AdvancedResponse) => {
        res.json({
            sources: ["github", "notion", "google_drive", "google_sheets", "google_slides", "onedrive", "web_crawler"],
            usage: {
                ingest: "POST /sources/:source/ingest { creds: {}, filters: {}, user_id? }",
                webhook: "POST /sources/webhook/:source (source-specific payload)"
            }
        });
    });

    // ingest from a source
    app.post("/sources/:source/ingest", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { source } = req.params;
            const validated = IngestSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid ingest parameters", validated.error.format()));
            }

            const { creds, filters } = validated.data;
            const user_id = req.user?.id;

            const source_map: Record<string, any> = {
                github: sources.github_source,
                notion: sources.notion_source,
                google_drive: sources.google_drive_source,
                google_sheets: sources.google_sheets_source,
                google_slides: sources.google_slides_source,
                onedrive: sources.onedrive_source,
                web_crawler: sources.web_crawler_source,
            };

            if (!source_map[source]) {
                return sendError(res, new AppError(400, "UNKNOWN_SOURCE", `unknown source: ${source}`, { available: Object.keys(source_map) }));
            }

            const src = new source_map[source](user_id);
            await src.connect(creds);
            const ids = await src.ingest_all(filters);
            res.json({ ok: true, ingested: ids.length, memory_ids: ids });
        } catch (e: any) {
            sendError(res, e);
        }
    });

    // webhook endpoint for github events
    app.post("/sources/webhook/github", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const event_type = req.headers["x-github-event"];
            const validated = GithubWebhookSchema.safeParse(req.body);

            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid payload", validated.error.format()));
            }

            const payload = validated.data;
            if (!payload || Object.keys(payload).length === 0) {
                return sendError(res, new AppError(400, "MISSING_PAYLOAD", "no payload"));
            }

            const { ingestDocument } = await import("../../ops/ingest");

            // handle different github events
            let content = "";
            let meta: Record<string, any> = { source: "github_webhook", event: event_type };

            if (event_type === "push") {
                const commits = payload.commits || [];
                content = commits.map((c: any) => `${c.message}\n${c.url}`).join("\n\n");
                meta.repo = payload.repository?.full_name;
                meta.ref = payload.ref;
            } else if (event_type === "issues") {
                content = `[${payload.action}] ${payload.issue?.title}\n${payload.issue?.body || ""}`;
                meta.repo = payload.repository?.full_name;
                meta.issue_number = payload.issue?.number;
            } else if (event_type === "pull_request") {
                content = `[${payload.action}] PR: ${payload.pull_request?.title}\n${payload.pull_request?.body || ""}`;
                meta.repo = payload.repository?.full_name;
                meta.pr_number = payload.pull_request?.number;
            } else {
                content = JSON.stringify(payload, null, 2);
            }

            if (content) {
                const result = await ingestDocument("text", content, meta);
                res.json({ ok: true, memory_id: result.root_memory_id, event: event_type });
            } else {
                res.json({ ok: true, skipped: true, reason: "no content" });
            }
        } catch (e: any) {
            sendError(res, e);
        }
    });

    // generic webhook for notion
    app.post("/sources/webhook/notion", async (req: AdvancedRequest, res: AdvancedResponse) => {
        const payload = req.body;

        try {
            const { ingestDocument } = await import("../../ops/ingest");
            const content = JSON.stringify(payload, null, 2);
            const result = await ingestDocument("text", content, { source: "notion_webhook" });
            res.json({ ok: true, memory_id: result.root_memory_id });
        } catch (e: any) {
            sendError(res, e);
        }
    });
}
