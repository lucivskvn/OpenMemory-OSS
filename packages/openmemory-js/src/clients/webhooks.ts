/**
 * @file webhooks.ts
 * @description sub-client for Webhook Management operations.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    Webhook,
    WebhookDeliveryResult,
} from "../core/types/admin";

/**
 * Webhook Management Operations sub-client.
 */
export class WebhooksClient extends BaseSubClient {
    async list(userId?: string, options?: { signal?: AbortSignal }): Promise<Webhook[]> {
        const uid = userId || this.defaultUser;
        const res = await this.request<{ hooks: Webhook[] }>(
            `/webhooks${uid ? `?userId=${uid}` : ""}`,
            { signal: options?.signal }
        );
        return res?.hooks || [];
    }

    /**
     * Create a new webhook.
     */
    async create(
        url: string,
        events: string[],
        secret?: string,
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<Webhook> {
        const body: Record<string, unknown> = { url, events, secret };
        if (userId) body.userId = userId;

        const res = await this.request<{ webhook: Webhook }>("/webhooks", {
            method: "POST",
            body: JSON.stringify(body),
            signal: options?.signal,
        });
        return res?.webhook;
    }

    async test(id: string, userId?: string, options?: { signal?: AbortSignal }): Promise<WebhookDeliveryResult> {
        const uid = userId || this.defaultUser;
        const res = await this.request<{ result: WebhookDeliveryResult }>(
            `/webhooks/${id}/test${uid ? `?userId=${uid}` : ""}`,
            {
                method: "POST",
                signal: options?.signal
            }
        );
        return res?.result;
    }

    async delete(id: string, userId?: string, options?: { signal?: AbortSignal }): Promise<boolean> {
        const uid = userId || this.defaultUser;
        await this.request(
            `/webhooks/${id}${uid ? `?userId=${uid}` : ""}`,
            { method: "DELETE", signal: options?.signal }
        );
        return true;
    }
}
