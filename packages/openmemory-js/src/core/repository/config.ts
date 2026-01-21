import { BaseRepository } from "./base";

export class ConfigRepository extends BaseRepository {
    async insSourceConfig(userId: string | null | undefined, type: string, config: string, status: string, ca: number, ua: number) {
        if (this.isPg) {
            return await this.runAsync(
                `insert into ${this.tables.source_configs}(user_id,type,config,status,created_at,updated_at) values(?,?,?,?,?,?) on conflict(user_id,type) do update set config=excluded.config,status=excluded.status,updated_at=excluded.updated_at`,
                [userId ?? null, type, config, status, ca, ua],
            );
        } else {
            return await this.runAsync(
                `insert or replace into ${this.tables.source_configs}(user_id,type,config,status,created_at,updated_at) values(?,?,?,?,?,?)`,
                [userId ?? null, type, config, status, ca, ua],
            );
        }
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
        if (this.isPg) {
            return await this.runAsync(
                `insert into ${this.tables.api_keys}(key_hash,user_id,role,note,created_at,updated_at,expires_at) values(?,?,?,?,?,?,?) on conflict(key_hash) do update set role=excluded.role,note=excluded.note,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
                [kh, uid, role, note, ca, ua, ea],
            );
        } else {
            return await this.runAsync(
                `insert or replace into ${this.tables.api_keys}(key_hash,user_id,role,note,created_at,updated_at,expires_at) values(?,?,?,?,?,?,?)`,
                [kh, uid, role, note, ca, ua, ea],
            );
        }
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

    // Classifier Model
    async getClassifierModel(userId: string | null | undefined) {
        return await this.getUser(
            `select * from ${this.tables.learned_models}`,
            [],
            userId
        );
    }

    async insClassifierModel(userId: string | null | undefined, weights: string, biases: string, version: number, updatedAt: number) {
        if (this.isPg) {
            return await this.runAsync(
                `insert into ${this.tables.learned_models} (user_id, weights, biases, version, updated_at) values(?,?,?,?,?) on conflict(user_id) do update set weights=excluded.weights, biases=excluded.biases, version=excluded.version, updated_at=excluded.updated_at`,
                [userId ?? null, weights, biases, version, updatedAt]
            );
        } else {
            return await this.runAsync(
                `insert or replace into ${this.tables.learned_models} (user_id, weights, biases, version, updated_at) values(?,?,?,?,?)`,
                [userId ?? null, weights, biases, version, updatedAt]
            );
        }
    }

    // System Configuration
    async setSystemConfig(key: string, value: string, type: string, description: string | null, user: string | null, now: number) {
        if (this.isPg) {
            return await this.runAsync(
                `insert into ${this.tables.config}(key, value, type, description, updated_at, updated_by) values(?,?,?,?,?,?) on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
                [key, value, type, description, now, user]
            );
        } else {
            return await this.runAsync(
                `insert or replace into ${this.tables.config}(key, value, type, description, updated_at, updated_by) values(?,?,?,?,?,?)`,
                [key, value, type, description, now, user]
            );
        }
    }

    async getSystemConfig(key: string) {
        return await this.getAsync(`select * from ${this.tables.config} where key=?`, [key]);
    }

    async getAllSystemConfigs() {
        return await this.allAsync(`select * from ${this.tables.config}`);
    }

    // Feature Flags
    async setFeatureFlag(name: string, enabled: boolean, rollout: number, conditions: string | null, now: number) {
        if (this.isPg) {
            return await this.runAsync(
                `insert into ${this.tables.feature_flags}(name, enabled, rollout_percentage, conditions, created_at, updated_at) values(?,?,?,?,?,?) on conflict(name) do update set enabled=excluded.enabled, rollout_percentage=excluded.rollout_percentage, conditions=excluded.conditions, updated_at=excluded.updated_at`,
                [name, enabled, rollout, conditions, now, now]
            );
        } else {
            return await this.runAsync(
                `insert or replace into ${this.tables.feature_flags}(name, enabled, rollout_percentage, conditions, created_at, updated_at) values(?,?,?,?,?,?)`,
                [name, enabled, rollout, conditions, now, now]
            );
        }
    }

    async getFeatureFlag(name: string) {
        return await this.getAsync(`select * from ${this.tables.feature_flags} where name=?`, [name]);
    }

    async getAllFeatureFlags() {
        return await this.allAsync(`select * from ${this.tables.feature_flags}`);
    }
}
