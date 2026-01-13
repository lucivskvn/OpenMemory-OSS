import { BaseRepository } from "./base";

export class UserRepository extends BaseRepository {
    async insUser(userId: string | null | undefined, summary: string, rc: number, ca: number, ua: number) {
        return await this.runAsync(
            `insert into ${this.tables.users}(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?) on conflict(user_id) do update set summary=excluded.summary,updated_at=excluded.updated_at`,
            [userId ?? null, summary, rc, ca, ua],
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
}
