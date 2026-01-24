/**
 * sources webhook routes - ingest data from external sources via HTTP
 *
 * POST /sources/:source/ingest
 *   body: { creds: {...}, filters: {...}, userId?: string }
 *
 * POST /sources/webhook/:source
 *   generic webhook endpoint for source-specific payloads
 */

import { Elysia } from "elysia";
import { z } from "zod";
import * as crypto from "crypto";

import { q } from "../../core/db"; // Static import
import {
    deletePersistedConfig,
    setPersistedConfig,
} from "../../core/persistedCfg";
import * as sources from "../../sources";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";
import { getUser, verifyUserAccess } from "../middleware/auth";
import type { UserContext } from "../middleware/auth";
import type { AuthScope } from "../../core/types"; // Import AuthScope

const IngestSchema = z.object({
    creds: z.record(z.string(), z.unknown()).optional().default({}),
    filters: z.record(z.string(), z.unknown()).optional().default({}),
    userId: z.string().optional(),
});

const SourceConfigSchema = z.object({
    config: z.record(z.string(), z.unknown()),
    status: z.enum(["enabled", "disabled"]).optional().default("enabled"),
    userId: z.string().optional(),
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

/**
 * Helper to ensure user has specific scope
 */
const requireScope = (user: UserContext | undefined, scope: string) => {
    if (!user) throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    // Simplified scope check: in real app, might need more complex logic
    // we cast scope to AuthScope for check
    if (user.scopes && !user.scopes.includes(scope as AuthScope) && !user.scopes.includes("admin:all")) {
        throw new AppError(403, "FORBIDDEN", `Missing scope: ${scope}`);
    }
};

/**
 * Registers source-related routes for ingestion and webhooks.
 */
export const sourceRoutes = (app: Elysia) => app
    /**
     * GET /sources
     * List available sources and usage instructions
     */
    .get("/sources", async () => {
        return {
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
        };
    })

    /**
     * POST /sources/:source/ingest
     * Trigger manual batch ingestion from a specific source.
     */
    .post("/sources/:source/ingest", async ({ params, body, ...ctx }) => {
        const { source } = params;
        const b = IngestSchema.parse(body);
        const user = getUser(ctx);
        const targetUserId = normalizeUserId(b.userId || user?.id);
        if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User context missing");

        verifyUserAccess(user, targetUserId);

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
            throw new AppError(
                400,
                "UNKNOWN_SOURCE",
                `unknown source: ${source}`,
                { available: Object.keys(sourceMap) },
            );
        }

        const src = new sourceMap[source](targetUserId) as sources.BaseSource;
        await src.connect(b.creds);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await src.ingestAll(b.filters as any);
        return {
            success: true,
            ingested: result.successfulIds.length,
            memoryIds: result.successfulIds,
            errors: result.errors,
        };
    })

    /**
     * POST /sources/webhook/github
     * Webhook endpoint for GitHub events.
     */
    .post("/sources/webhook/github", async ({ request, query, set }) => {
        try {
            const eventType = request.headers.get("x-github-event");
            const signature = request.headers.get("x-hub-signature-256");
            const webhookSecret = Bun.env.GITHUB_WEBHOOK_SECRET;

            // 1. Read Raw Body for HMAC
            const rawBody = await request.text();

            // 2. Verify Signature if secret is configured
            if (webhookSecret && signature) {
                const hmac = crypto.createHmac("sha256", webhookSecret);
                const digest = "sha256=" + hmac.update(rawBody).digest("hex");
                if (signature !== digest) {
                    logger.warn("[sources] GitHub HMAC signature mismatch", { signature, digest });
                    throw new AppError(401, "UNAUTHORIZED", "Invalid signature");
                }
            } else if (webhookSecret && !signature) {
                logger.warn("[sources] GitHub webhook missing signature");
                throw new AppError(401, "UNAUTHORIZED", "Missing signature");
            }

            if (!rawBody.trim()) {
                return { success: true, skipped: true, reason: "empty body" };
            }

            const payload = GithubWebhookSchema.parse(JSON.parse(rawBody));

            logger.info(`[debug] GitHub Payload type: ${typeof payload}`, { payloadKeys: Object.keys(payload) });

            // handle different github events
            let content = "";
            const meta: Record<string, unknown> = {
                source: "github_webhook",
                event: eventType as string,
            };

            // Allow mapping to a specific user via query parameter ?userId=...
            const queryUser = query.userId as string | undefined;
            const webhookUser = queryUser || null; // Default to System (null)

            if (webhookUser) {
                logger.info(
                    `[sources] GitHub webhook triggered for user: ${webhookUser}`,
                );
            }

            if (eventType === "push") {
                const commits = payload.commits || [];
                content = commits
                    .map((c: any) => {
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
                const result = await ingestDocument("text", content, {
                    metadata: meta,
                    userId: webhookUser,
                });
                return {
                    success: true,
                    memoryId: result.rootMemoryId,
                    event: eventType,
                };
            } else {
                return { success: true, skipped: true, reason: "no content" };
            }

        } catch (e: any) {
            logger.error("[sources] GitHub webhook error:", { error: e });
            set.status = e instanceof AppError ? e.statusCode : 500;
            return { success: false, error: e.message };
        }
    })

    /**
     * POST /sources/webhook/notion
     * Webhook endpoint for Notion.
     */
    .post("/sources/webhook/notion", async ({ body, query, set }) => {
        const NotionWebhookSchema = z.object({}).passthrough();
        const payload = NotionWebhookSchema.parse(body);

        try {
            if (!payload || Object.keys(payload).length === 0) {
                logger.warn("[sources] Notion webhook payload empty/missing");
                throw new AppError(400, "MISSING_PAYLOAD", "no payload provided");
            }

            const content = JSON.stringify(payload, null, 2);

            // Security: Secret-based URL verification for Notion
            const notionSecret = Bun.env.NOTION_WEBHOOK_SECRET;
            const querySecret = query.secret as string | undefined;
            if (notionSecret && querySecret !== notionSecret) {
                logger.warn(`[sources] Notion webhook secret mismatch`);
                throw new AppError(401, "INVALID_SECRET", "secret mismatch");
            }

            const queryUser = query.userId as string | undefined;
            const webhookUser = normalizeUserId(queryUser);

            const result = await ingestDocument("text", content, {
                metadata: { source: "notion_webhook" },
                userId: webhookUser,
            });
            return { success: true, memoryId: result.rootMemoryId };
        } catch (e: any) {
            logger.error("[sources] Notion webhook error:", { error: e });
            if (e instanceof AppError) throw e;
            set.status = 500;
            return { success: false, error: e.message };
        }
    })

    /**
     * GET /source-configs
     * Lists persisted source configurations.
     */
    .get("/source-configs", async (ctx) => {
        const user = getUser(ctx);
        const targetUserId = normalizeUserId((ctx.query.userId as string) || user?.id);
        if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User context missing");

        verifyUserAccess(user, targetUserId);

        const configs = await q.getSourceConfigsByUser.all(targetUserId);
        return {
            success: true,
            configs: configs.map((c: any) => ({
                type: c.type,
                status: c.status,
                updatedAt: c.updatedAt,
            })),
        };
    })

    /**
     * POST /source-configs/:type
     * Create or update a persistent source configuration.
     */
    .post("/source-configs/:type", async ({ params, body, ...ctx }) => {
        const user = getUser(ctx);
        const { type } = params;
        const { config, status, userId: bodyUserId } = SourceConfigSchema.parse(body);

        const targetUserId = normalizeUserId(bodyUserId || user?.id);
        if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User context missing");

        verifyUserAccess(user, targetUserId);

        const configStatus = status || "enabled";
        await setPersistedConfig(targetUserId, type, config, configStatus);

        return { success: true, type, status: configStatus };
    })

    /**
     * DELETE /source-configs/:type
     * Deletes a source configuration.
     */
    .delete("/source-configs/:type", async ({ params, query, ...ctx }) => {
        const user = getUser(ctx);
        const { type } = params;
        const targetUserId = normalizeUserId((query.userId as string) || user?.id);
        if (!targetUserId) throw new AppError(401, "UNAUTHORIZED", "User context missing");

        verifyUserAccess(user, targetUserId);

        await deletePersistedConfig(targetUserId, type);
        return { success: true, deleted: type };
    });
