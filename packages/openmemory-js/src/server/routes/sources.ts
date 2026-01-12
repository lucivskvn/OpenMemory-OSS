/**
 * sources webhook routes - ingest data from external sources via HTTP
 *
 * POST /sources/:source/ingest
 *   body: { creds: {...}, filters: {...}, userId?: string }
 *
 * POST /sources/webhook/:source
 *   generic webhook endpoint for source-specific payloads
 */

import { z } from "zod";

import { q } from "../../core/db"; // Static import
import {
    deletePersistedConfig,
    setPersistedConfig,
} from "../../core/persisted_cfg";
import * as sources from "../../sources";
import { GithubSource } from "../../sources/github";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import { AppError, sendError } from "../errors";
import { validateBody } from "../middleware/validate";

const IngestSchema = z.object({
    creds: z.record(z.string(), z.unknown()).optional().default({}),
    filters: z.record(z.string(), z.unknown()).optional().default({}),
    userId: z.string().optional(),
});

const SourceConfigSchema = z.object({
    config: z.record(z.string(), z.unknown()),
    status: z.enum(["enabled", "disabled"]).optional().default("enabled"),
});

const GithubWebhookSchema = z
    .object({
        commits: z.array(z.unknown()).optional(),
        repository: z.object({ full_name: z.string().optional() }).optional(),
        ref: z.string().optional(),
        action: z.string().optional(),
        issue: z
            .object({
                title: z.string().optional(),
                body: z.string().optional(),
                number: z.number().optional(),
            })
            .optional(),
        pull_request: z
            .object({
                title: z.string().optional(),
                body: z.string().optional(),
                number: z.number().optional(),
            })
            .optional(),
    })
    .passthrough();

import { ingestDocument } from "../../ops/ingest"; // Static import
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

/**
 * Registers source-related routes for ingestion and webhooks.
 * @param app The server application instance.
 */
export function sourceRoutes(app: ServerApp) {
    /**
     * list available sources and usage instructions
     */
    app.get(
        "/sources",
        async (_req: AdvancedRequest, res: AdvancedResponse) => {
            res.json({
                sources: [
                    "github",
                    "notion",
                    "google_drive",
                    "google_sheets",
                    "google_slides",
                    "onedrive",
                    "web_crawler",
                ],
                usage: {
                    ingest: "POST /sources/:source/ingest { creds: {}, filters: {}, userId? }",
                    webhook:
                        "POST /sources/webhook/:source (source-specific payload)",
                },
            });
        },
    );

    /**
     * Trigger manual batch ingestion from a specific source.
     * Combines user-provided credentials with persisted config.
     *
     * @param source - The source type (e.g., 'github', 'notion').
     */
    app.post(
        "/sources/:source/ingest",
        validateBody(IngestSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { source } = req.params;
                const { creds, filters } = req.body as z.infer<
                    typeof IngestSchema
                >;
                const userId = req.user?.id;

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const sourceMap: Record<string, any> = {
                    github: sources.GithubSource,
                    notion: sources.NotionSource,
                    google_drive: sources.GoogleDriveSource,
                    google_sheets: sources.GoogleSheetsSource,
                    google_slides: sources.GoogleSlidesSource,
                    onedrive: sources.OneDriveSource,
                    web_crawler: sources.WebCrawlerSource,
                };

                if (!sourceMap[source]) {
                    return sendError(
                        res,
                        new AppError(
                            400,
                            "UNKNOWN_SOURCE",
                            `unknown source: ${source}`,
                            { available: Object.keys(sourceMap) },
                        ),
                    );
                }

                const src = new sourceMap[source](userId) as sources.BaseSource;

                // Security: BaseSource.connect now handles "Dashboard-First" hydration internally.
                // We only pass explicitly provided creds from the request body if present.
                await src.connect(creds);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const result = await src.ingestAll(filters as any);
                res.json({
                    ok: true,
                    ingested: result.successfulIds.length,
                    memoryIds: result.successfulIds,
                    errors: result.errors,
                });
            } catch (e: unknown) {
                logger.error("[sources] ingest error:", { error: e });
                sendError(res, e);
            }
        },
    );

    /**
     * Webhook endpoint for GitHub events (Push, Issue, PR).
     * Verifies HMAC signature if `GITHUB_WEBHOOK_SECRET` is set.
     */
    app.post(
        "/sources/webhook/github",
        validateBody(GithubWebhookSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const eventType = req.headers["x-github-event"];
                const payload = req.body as z.infer<typeof GithubWebhookSchema>;

                logger.info(`[debug] GitHub Payload type: ${typeof payload}`, { payload, headers: req.headers });

                if (!payload) {
                    return sendError(
                        res,
                        new AppError(400, "MISSING_PAYLOAD", "no payload"),
                    );
                }

                logger.info(`[sources] GitHub webhook payload keys: ${Object.keys(payload)}`);

                // handle different github events
                let content = "";
                const meta: Record<string, unknown> = {
                    source: "github_webhook",
                    event: eventType as string,
                };

                // Allow mapping to a specific user via query parameter ?userId=...
                // Security Note: In production, ensure the webhook URL is kept secret or implement signature verification.
                const queryUser = req.query.userId as string | undefined;
                const webhookUser = queryUser || null; // Default to System (null)

                if (webhookUser) {
                    logger.info(
                        `[sources] GitHub webhook triggered for user: ${webhookUser}`,
                    );
                }

                // Security: HMAC signature check
                const signature = req.headers["x-hub-signature-256"] as string;
                const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

                if (webhookSecret && signature) {
                    // We assume req.body is already parsed, but for HMAC we need the raw string.
                    // In a production app, we would use a raw body middleware.
                    const rawBody = JSON.stringify(payload);
                    if (
                        !GithubSource.verifySignature(
                            signature,
                            rawBody,
                            webhookSecret,
                        )
                    ) {
                        logger.warn(
                            `[sources] GitHub webhook signature mismatch for user: ${webhookUser}`,
                        );
                        return sendError(
                            res,
                            new AppError(
                                401,
                                "INVALID_SIGNATURE",
                                "signature mismatch",
                            ),
                        );
                    }
                } else if (webhookSecret) {
                    logger.error(
                        `[sources] GitHub webhook secret configured but signature missing from request`,
                    );
                    return sendError(
                        res,
                        new AppError(
                            401,
                            "MISSING_SIGNATURE",
                            "signature missing",
                        ),
                    );
                }

                if (eventType === "push") {
                    const commits = payload.commits || [];
                    content = commits
                        .map((c: unknown) => {
                            const commit = c as { message: string; url: string };
                            return `${commit.message}\n${commit.url}`;
                        })
                        .join("\n\n");
                    meta.repo = payload.repository?.full_name;
                    meta.ref = payload.ref;
                } else if (eventType === "issues") {
                    content = `[${payload.action}] ${payload.issue?.title}\n${payload.issue?.body || ""}`;
                    meta.repo = payload.repository?.full_name;
                    meta.issueNumber = payload.issue?.number;
                } else if (eventType === "pull_request") {
                    content = `[${payload.action}] PR: ${payload.pull_request?.title}\n${payload.pull_request?.body || ""}`;
                    meta.repo = payload.repository?.full_name;
                    meta.prNumber = payload.pull_request?.number;
                } else {
                    content = JSON.stringify(payload, null, 2);
                }

                if (content) {
                    // Pass header-based or query-based user
                    const result = await ingestDocument(
                        "text",
                        content,
                        meta,
                        undefined,
                        webhookUser,
                    );
                    res.json({
                        ok: true,
                        memoryId: result.rootMemoryId,
                        event: eventType,
                    });
                } else {
                    res.json({ ok: true, skipped: true, reason: "no content" });
                }
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    const NotionWebhookSchema = z.object({}).passthrough();

    /**
     * Generic webhook endpoint for Notion automation.
     * Verifies secret via `?secret=` query param (Notion limitation).
     */
    app.post(
        "/sources/webhook/notion",
        validateBody(NotionWebhookSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            const payload = req.body;

            try {
                if (!payload || Object.keys(payload).length === 0) {
                    logger.warn("[sources] Notion webhook payload empty/missing");
                    return sendError(
                        res,
                        new AppError(
                            400,
                            "MISSING_PAYLOAD",
                            "no payload provided",
                        ),
                    );
                }
                logger.info(`[sources] Notion webhook payload keys: ${Object.keys(payload)}`);
                const content = JSON.stringify(payload, null, 2);

                // Security: Secret-based URL verification for Notion
                const notionSecret = process.env.NOTION_WEBHOOK_SECRET;
                const querySecret = req.query.secret as string | undefined;
                if (notionSecret && querySecret !== notionSecret) {
                    logger.warn(`[sources] Notion webhook secret mismatch`);
                    return sendError(
                        res,
                        new AppError(401, "INVALID_SECRET", "secret mismatch"),
                    );
                }

                const queryUser = req.query.userId as string | undefined;
                const webhookUser = normalizeUserId(queryUser);

                const result = await ingestDocument(
                    "text",
                    content,
                    { source: "notion_webhook" },
                    undefined,
                    webhookUser,
                );
                res.json({ ok: true, memoryId: result.rootMemoryId });
            } catch (e: unknown) {
                logger.error("[sources] webhook error:", { error: e });
                sendError(res, e);
            }
        },
    );

    /**
     * Lists persisted source configurations for the authenticated user.
     * Returns metadata only (hides secrets).
     */
    app.get(
        "/source-configs",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const userId = req.user?.id || null;
                const configs = await q.getSourceConfigsByUser.all(userId);
                // Hide sensitive config details in list
                res.json({
                    ok: true,
                    configs: configs.map((c) => ({
                        type: c.type,
                        status: c.status,
                        updatedAt: c.updatedAt,
                    })),
                });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    /**
     * Create or update a persistent source configuration.
     * Stored encrypted in the database.
     */
    app.post(
        "/source-configs/:type",
        validateBody(SourceConfigSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { type } = req.params;
                const { config, status } = req.body as z.infer<
                    typeof SourceConfigSchema
                >;
                const userId = req.user?.id || null;
                const configStatus = status || "enabled";

                await setPersistedConfig(userId, type, config, configStatus);

                res.json({ ok: true, type, status });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );

    /**
     * Deletes a source configuration.
     */
    app.delete(
        "/source-configs/:type",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { type } = req.params;
                const userId = req.user?.id || null;
                await deletePersistedConfig(userId, type);
                res.json({ ok: true, deleted: type });
            } catch (e: unknown) {
                sendError(res, e);
            }
        },
    );
}
