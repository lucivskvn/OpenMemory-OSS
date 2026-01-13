import { BaseRepository } from "./base";

export class ConfigRepository extends BaseRepository {
    async insSourceConfig(userId: string | null | undefined, type: string, config: string, status: string, ca: number, ua: number) {
        return await this.runAsync(
            `insert into ${this.tables.source_configs}(user_id,type,config,status,created_at,updated_at) values(?,?,?,?,?,?) on conflict(user_id,type) do update set config=excluded.config,status=excluded.status,updated_at=excluded.updated_at`,
            [userId ?? null, type, config, status, ca, ua],
        );
    }

    async getSourceConfig(userId: string | null | undefined, type: string) {
        return await this.getUser(
            `select * from ${this.tables.source_configs} where type=?`,
            [type],
            userId,
        );
    }

    async updSourceConfig(userId: string | null | undefined, type: string, config: string, status: string, ua: number) {
        return await this.runAsync(
            `update ${this.tables.source_configs} set config=?, status=?, updated_at=? where user_id=? and type=?`,
            [config, status, ua, userId ?? null, type],
        );
    }

    async getSourceConfigsByUser(userId: string | null | undefined) {
        return await this.allUser<any>(
            `select * from ${this.tables.source_configs}`,
            [],
            userId,
        );
    }

    async delSourceConfig(userId: string | null | undefined, type: string) {
        return await this.runUser(
            `delete from ${this.tables.source_configs} where type=?`,
            [type],
            userId,
        );
    }

    async insApiKey(kh: string, uid: string, role: string, note: string | null, ca: number, ua: number, ea: number) {
        return await this.runAsync(
            `insert into ${this.tables.api_keys}(key_hash,user_id,role,note,created_at,updated_at,expires_at) values(?,?,?,?,?,?,?) on conflict(key_hash) do update set role=excluded.role,note=excluded.note,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
            [kh, uid, role, note, ca, ua, ea],
        );
    }

    async getApiKey(kh: string) {
        return await this.getAsync<any>(`select * from ${this.tables.api_keys} where key_hash=?`, [kh]);
    }

    async delApiKey(kh: string, userId?: string) {
        if (userId) {
            return await this.runAsync(`delete from ${this.tables.api_keys} where key_hash=? and user_id=?`, [kh, userId]);
        }
        return await this.runAsync(`delete from ${this.tables.api_keys} where key_hash=?`, [kh]);
    }

    async getApiKeysByUser(userId: string) {
        return await this.allAsync<any>(`select * from ${this.tables.api_keys} where user_id=?`, [userId]);
    }

    async getAllApiKeys() {
        return await this.allAsync<any>(`select * from ${this.tables.api_keys} order by created_at desc`);
    }

    async getAdminCount() {
        return await this.getAsync<{ count: number }>(`select count(*) as count from ${this.tables.api_keys} where role='admin'`);
    }

    async delSourceConfigsByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.source_configs} where user_id=?`, [userId]);
    }

    async delLearnedModelByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.learned_models} where user_id=?`, [userId]);
    }

    async delApiKeysByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.api_keys} where user_id=?`, [userId]);
    }
}
