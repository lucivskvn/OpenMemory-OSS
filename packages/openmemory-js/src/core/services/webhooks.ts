/**
 * @file Webhook management service for OpenMemory.
 * Handles webhook registration, delivery, and lifecycle management.
 * 
 * @module core/services/webhooks
 */
import { q } from "../db";
import { now, toHex } from "../../utils";
import { logger } from "../../utils/logger";
import { retry } from "../../utils/retry";

import { eventBus, EVENTS } from "../events";
import { Webhook, WebhookDeliveryResult } from "../types";

// Re-export for service usage if needed, or just use from types
export type { Webhook, WebhookDeliveryResult };

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 * @param payload - The payload to sign
 * @param secret - The webhook secret
 * @returns The signature as hex string
 */
async function generateSignature(payload: string, secret: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await globalThis.crypto.subtle.sign(
        "HMAC",
        key,
        enc.encode(payload)
    );
    return toHex(new Uint8Array(signature));
}

/**
 * Parse events JSON safely with fallback.
 * @param eventsJson - Raw events JSON string
 * @returns Parsed array or empty array on error
 */
function parseEvents(eventsJson: string | null): string[] {
    if (!eventsJson) return [];
    try {
        const parsed = JSON.parse(eventsJson);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        logger.warn("[WebhookService] Failed to parse events JSON", { eventsJson });
        return [];
    }
}

interface WebhookRow {
    id: string;
    userId?: string;
    user_id?: string;
    url: string;
    events: string | null;
    secret?: string;
    status: Webhook["status"];
    retryCount?: number;
    retry_count?: number;
    lastTriggered?: number;
    last_triggered?: number;
    createdAt?: number;
    created_at?: number;
    updatedAt?: number;
    updated_at?: number;
}

/**
 * Map database row to Webhook interface.
 * @param row - Raw database row
 * @param includeSecret - Whether to include the secret (only for create)
 */
function mapRowToWebhook(row: WebhookRow, includeSecret = false): Webhook {
    const webhook: Webhook = {
        id: row.id,
        userId: (row.userId || row.user_id)!, // userId is required in schema usually
        url: row.url,
        events: parseEvents(row.events),
        status: row.status || "active",
        retryCount: row.retryCount ?? row.retry_count ?? 0,
        lastTriggered: row.lastTriggered ?? row.last_triggered,
        createdAt: row.createdAt ?? row.created_at ?? 0,
        updatedAt: row.updatedAt ?? row.updated_at ?? 0,
    };

    // Only include secret when explicitly requested (e.g., on create)
    if (includeSecret && row.secret) {
        webhook.secret = row.secret;
    }

    return webhook;
}

/**
 * Service for managing webhooks.
 * Uses the repository layer via q object for database operations.
 */
export class WebhookService {
    private static readonly MAX_LIST_LIMIT = 100;
    private static readonly DEFAULT_LIST_LIMIT = 20;
    private static readonly MAX_RETRIES = 3;
    private static readonly RETRY_DELAY_MS = 1000;
    private static instance: WebhookService;
    private started = false;

    static start() {
        if (!this.instance) {
            this.instance = webhookService; // Use the exported instance
            this.instance.init();
        }
    }

    private init() {
        if (this.started) return;
        this.started = true;
        logger.info("[Webhooks] Service started");

        // Subscribe to all known events
        Object.values(EVENTS).forEach(event => {
            eventBus.on(event as any, (payload: any) => {
                this.handleEvent(event, payload).catch(err => {
                    logger.error(`[Webhooks] Error handling event ${event}`, { error: err });
                });
            });
        });
    }

    private async handleEvent(eventType: string, payload: unknown) {
        // We need userId to find relevant webhooks
        // Payload convention: userId is top-level property if present
        const p = payload as Record<string, unknown>;
        const userId = typeof p === "object" && p !== null ? (p.userId as string | undefined) : undefined;

        if (!userId) return;

        try {
            // Fetch webhooks for this user
            const hooks = await this.list(userId, 100);

            if (!hooks || hooks.length === 0) return;

            for (const hook of hooks) {
                // Check if hook subscribes to this event
                if (!hook.events.includes("*") && !hook.events.includes(eventType)) {
                    continue;
                }

                // Dispatch async using the robust deliver method
                this.deliver(hook.id, eventType, payload as Record<string, unknown>).catch(err => {
                    logger.error(`[Webhooks] Dispatch failed for ${hook.id}`, { error: err });
                });
            }
        } catch (e) {
            logger.error("[Webhooks] Failed to fetch hooks", { error: e });
        }
    }

    /**
     * Create a new webhook registration.
     * @param userId - Owner of the webhook.
     * @param url - Target URL for webhook delivery.
     * @param events - Array of event types to subscribe to.
     * @param secret - Shared secret for HMAC signature verification.
     * @returns The created webhook object (includes secret for this response only).
     * @throws Error if URL is invalid or events array is empty.
     */
    async create(
        userId: string,
        url: string,
        events: string[],
        secret: string
    ): Promise<Webhook> {
        // Input validation
        if (!url || typeof url !== "string") {
            throw new Error("Invalid webhook URL");
        }
        if (!events || !Array.isArray(events) || events.length === 0) {
            throw new Error("Events array must not be empty");
        }
        if (!secret || secret.length < 16) {
            throw new Error("Secret must be at least 16 characters");
        }

        // Validate URL format
        try {
            new URL(url);
        } catch {
            throw new Error("Invalid webhook URL format");
        }

        const id = globalThis.crypto.randomUUID();
        const ts = now();

        await q.createWebhook.run({
            id,
            userId,
            url,
            events: JSON.stringify(events),
            secret,
            createdAt: ts,
        });

        logger.info("[WebhookService] Webhook created", { id, userId, events });

        return {
            id,
            userId,
            url,
            events,
            secret, // Include on create only
            status: "active",
            retryCount: 0,
            createdAt: ts,
            updatedAt: ts,
        };
    }

    /**
     * Get a single webhook by ID.
     * @param id - Webhook ID.
     * @param userId - Owner of the webhook (for authorization).
     * @returns The webhook or null if not found.
     */
    async get(id: string, userId: string): Promise<Webhook | null> {
        const row = await q.getWebhook.get(id, userId);
        if (!row) return null;
        return mapRowToWebhook(row as any, false); // Never expose secret on get
    }

    /**
     * List webhooks for a user.
     * @param userId - Owner of the webhooks.
     * @param limit - Maximum number of results. Default: 20, Max: 100.
     * @returns Array of webhook objects (secrets are not included).
     */
    async list(userId: string, limit = WebhookService.DEFAULT_LIST_LIMIT): Promise<Webhook[]> {
        // Enforce pagination bounds
        const safeLimit = Math.min(
            Math.max(1, limit),
            WebhookService.MAX_LIST_LIMIT
        );

        const rows = await q.listWebhooks.all(userId);

        return rows
            .slice(0, safeLimit)
            .map((r: any) => mapRowToWebhook(r, false)); // Never expose secrets in list
    }

    /**
     * Delete a webhook.
     * @param id - Webhook ID to delete.
     * @param userId - Owner of the webhook (for authorization).
     * @returns True if deletion was successful.
     */
    async delete(id: string, userId: string): Promise<boolean> {
        const result = await q.deleteWebhook.run(id, userId);
        const deleted = result > 0;

        if (deleted) {
            logger.info("[WebhookService] Webhook deleted", { id, userId });
        }

        return deleted;
    }

    /**
     * Deliver a webhook payload to the target URL.
     * Includes HMAC signature and retry logic.
     * @param webhookId - The webhook to deliver to.
     * @param eventType - The type of event being delivered.
     * @param payload - The payload object to deliver.
     * @returns Delivery result with status information.
     */
    async deliver(
        webhookId: string,
        eventType: string,
        payload: Record<string, unknown>
    ): Promise<WebhookDeliveryResult> {
        // Fetch raw row to get the secret (which is not in the mapped Webhook object by default)
        const row = (await q.getWebhook.get(webhookId)) as WebhookRow | undefined;
        if (!row) {
            return { success: false, error: "Webhook not found", attemptCount: 0 };
        }

        const webhook = mapRowToWebhook(row, true); // Include secret

        if (webhook.status === "paused" || webhook.status === "failed") {
            return { success: false, error: `Webhook is ${webhook.status}`, attemptCount: 0 };
        }

        if (!webhook.secret) {
            // Try to use the secret from the row directly if mapRowToWebhook failed to set it (though it should if includeSecret=true)
            if (row.secret) webhook.secret = row.secret;
        }

        const payloadStr = JSON.stringify(payload);

        if (!webhook.secret) {
            return { success: false, error: "Webhook signing secret missing", attemptCount: 0 };
        }

        const actualSignature = await generateSignature(payloadStr, webhook.secret);

        const logId = globalThis.crypto.randomUUID();
        const ts = now();

        // Log delivery attempt
        await q.logWebhookDelivery.run({
            id: logId,
            webhookId,
            eventType,
            payload: payloadStr,
            status: "pending",
            createdAt: ts,
        });

        let attemptCount = 0;
        let lastError: string | undefined;
        let statusCode: number | undefined;

        try {
            const result = await retry(
                async () => {
                    attemptCount++;

                    const response = await fetch(webhook.url, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-OpenMemory-Signature": actualSignature,
                            "X-OpenMemory-Event": eventType,
                            "X-OpenMemory-Delivery": logId,
                        },
                        body: payloadStr,
                        signal: AbortSignal.timeout(10000), // 10s timeout
                    });

                    statusCode = response.status;

                    if (!response.ok) {
                        const body = await response.text().catch(() => "");
                        throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
                    }

                    return response;
                },
                {
                    retries: WebhookService.MAX_RETRIES,
                    delay: WebhookService.RETRY_DELAY_MS,
                    decay: 2, // Exponential backoff multiplier
                }
            );

            // Update log with success
            await q.updateWebhookLog.run({
                id: logId,
                status: "delivered",
                code: statusCode ?? 0, // Fix undefined
                body: null,
                completedAt: now(),
            });

            logger.info("[WebhookService] Webhook delivered", { webhookId, eventType, statusCode });

            return { success: true, statusCode, attemptCount };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);

            // Update log with failure
            await q.updateWebhookLog.run({
                id: logId,
                status: "failed",
                code: statusCode ?? 0, // Fix undefined
                body: lastError?.slice(0, 1000) ?? "Unknown Error",
                completedAt: now(),
            });

            logger.error("[WebhookService] Webhook delivery failed", {
                webhookId,
                eventType,
                attemptCount,
                error: lastError,
            });

            return { success: false, statusCode, error: lastError, attemptCount };
        }
    }

    /**
     * Test a webhook by sending a test payload.
     * @param id - Webhook ID to test.
     * @param userId - Owner of the webhook.
     * @returns Delivery result.
     */
    async test(id: string, userId: string): Promise<WebhookDeliveryResult> {
        const webhook = await this.get(id, userId);
        if (!webhook) {
            return { success: false, error: "Webhook not found", attemptCount: 0 };
        }

        return this.deliver(id, "test", {
            type: "test",
            timestamp: now(),
            message: "This is a test delivery from OpenMemory",
        });
    }
}

export const webhookService = new WebhookService();
