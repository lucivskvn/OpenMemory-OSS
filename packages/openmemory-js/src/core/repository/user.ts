import { BaseRepository } from "./base";
import { vectorStore } from "../vector/manager";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";

export class UserRepository extends BaseRepository {
    async insUser(userId: string | null | undefined, summary: string, reflectionCount: number, createdAt: number, updatedAt: number) {
        return await this.runAsync(
            `insert into ${this.tables.users}(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?) on conflict(user_id) do update set summary=excluded.summary,updated_at=excluded.updated_at`,
            [userId ?? null, summary, reflectionCount, createdAt, updatedAt],
        );
    }

    async getById(userId: string | null | undefined) {
        return await this.getAsync<any>(`select * from ${this.tables.users} where user_id=?`, [userId ?? null]);
    }

    async updateReflectionCount(userId: string | null | undefined, rc: number) {
        return await this.runAsync(
            `update ${this.tables.users} set reflection_count=?,updated_at=? where user_id=?`,
            [rc, Date.now(), userId ?? null],
        );
    }

    async updUserSummary(userId: string | null | undefined, summary: string, ua: number) {
        return await this.runAsync(
            `update ${this.tables.users} set summary=?,updated_at=?,reflection_count=reflection_count+1 where user_id=?`,
            [summary, ua, userId ?? null],
        );
    }

    async getActiveUsers() {
        return await this.allAsync<{ userId: string }>(
            `select distinct user_id as userId from ${this.tables.memories} union select distinct user_id as userId from ${this.tables.users}`,
        );
    }

    async getUsers(limit = 100, offset = 0) {
        return await this.allAsync<{ userId: string; summary: string }>(
            `select user_id as userId, summary from ${this.tables.users} order by updated_at desc limit ? offset ?`,
            [limit, offset],
        );
    }

    async delUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.users} where user_id=?`, [userId]);
    }

    async delStatsByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.stats} where user_id=?`, [userId]);
    }

    async deleteUserCascade(userId: string) {
        const uid = normalizeUserId(userId);
        if (!uid) return 0;

        return await this.transaction.run(async () => {
            // Delete in cascade order: logs, integrations, core data, user record

            // 1. Logs and non-core data
            await this.runAsync(`delete from ${this.tables.audit_logs} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.embed_logs} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.maint_logs} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.stats} where user_id=?`, [uid]);

            // 2. Configuration & Integrations
            await this.runAsync(`delete from ${this.tables.source_configs} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.api_keys} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.learned_models} where user_id=?`, [uid]);

            // 3. Webhooks (including logs)
            await this.runAsync(`delete from ${this.tables.webhook_logs} where webhook_id in (select id from ${this.tables.webhooks} where user_id=?)`, [uid]);
            await this.runAsync(`delete from ${this.tables.webhooks} where user_id=?`, [uid]);

            // 4. Core Memory Graph Data
            await this.runAsync(`delete from ${this.tables.waypoints} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.temporal_edges} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.temporal_facts} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.vectors} where user_id=?`, [uid]);
            await this.runAsync(`delete from ${this.tables.memories} where user_id=?`, [uid]);

            // 5. Final User record
            const res = await this.delUser(uid);

            // 6. Async/External cleanup (Vector Store backends like Valkey)
            try {
                await vectorStore.deleteVectorsByUser(uid);
            } catch (e) {
                logger.warn(`[UserRepository] Failed to cleanup external vectors for user ${uid}:`, { error: e });
            }

            return res;
        });
    }
}
