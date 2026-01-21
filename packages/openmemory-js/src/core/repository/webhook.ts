import { BaseRepository } from "./base";
import type { WebhookCreateParams, WebhookLogDeliveryParams, WebhookUpdateLogParams } from "../types/admin";

export class WebhookRepository extends BaseRepository {
    async create(params: import("../types").WebhookCreateParams) {
        return await this.runAsync(
            `insert into ${this.tables.webhooks}(id, user_id, url, events, secret, created_at, updated_at) values(?,?,?,?,?,?,?)`,
            [params.id, params.userId, params.url, params.events, params.secret, params.createdAt, params.createdAt]
        );
    }

    async list(userId?: string) {
        if (userId) {
            return await this.allUser(
                `select * from ${this.tables.webhooks}`,
                [],
                userId
            );
        }
        return await this.allAsync(`select * from ${this.tables.webhooks}`);
    }

    async delete(id: string, userId: string) {
        return await this.transaction.run(async () => {
            await this.runAsync(
                `delete from ${this.tables.webhook_logs} where webhook_id=?`,
                [id]
            );
            return await this.runUser(
                `delete from ${this.tables.webhooks} where id=?`,
                [id],
                userId
            );
        });
    }

    async get(id: string, userId?: string) {
        return await this.getUser(
            `select * from ${this.tables.webhooks} where id=?`,
            [id],
            userId
        );
    }

    // Webhook Logging
    async logDelivery(params: import("../types").WebhookLogDeliveryParams) {
        return await this.runAsync(
            `insert into ${this.tables.webhook_logs}(id, webhook_id, event_type, payload, status, created_at, attempt_count) values(?,?,?,?,?,?,1)`,
            [params.id, params.webhookId, params.eventType, params.payload, params.status, params.createdAt]
        );
    }

    async updateLog(params: import("../types").WebhookUpdateLogParams) {
        return await this.runAsync(
            `update ${this.tables.webhook_logs} set status=?, response_code=?, response_body=?, completed_at=? where id=?`,
            [params.status, params.code, params.body, params.completedAt, params.id]
        );
    }

    async delWebhooksByUser(userId: string) {
        return await this.transaction.run(async () => {
            await this.runAsync(
                `delete from ${this.tables.webhook_logs} where webhook_id in (select id from ${this.tables.webhooks} where user_id=?)`,
                [userId]
            );
            return await this.runAsync(
                `delete from ${this.tables.webhooks} where user_id=?`,
                [userId]
            );
        });
    }
}
