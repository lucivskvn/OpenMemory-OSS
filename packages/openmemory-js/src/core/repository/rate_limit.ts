import { BaseRepository } from "./base";
import type { RateLimitUpdateParams } from "../types/system";

export class RateLimitRepository extends BaseRepository {
    async get(key: string) {
        return await this.getAsync(
            `select * from ${this.tables.rate_limits} where key=?`,
            [key]
        );
    }

    async update(params: import("../types").RateLimitUpdateParams) {
        // Upsert logic
        if (this.isPg) {
            return await this.runAsync(
                `insert into ${this.tables.rate_limits}(key, window_start, request_count, cost_units, last_request) values(?,?,?,?,?) on conflict(key) do update set window_start=excluded.window_start, request_count=excluded.request_count, cost_units=excluded.cost_units, last_request=excluded.last_request`,
                [params.key, params.windowStart, params.count, params.cost, params.lastRequest]
            );
        } else {
            return await this.runAsync(
                `insert or replace into ${this.tables.rate_limits}(key, window_start, request_count, cost_units, last_request) values(?,?,?,?,?)`,
                [params.key, params.windowStart, params.count, params.cost, params.lastRequest]
            );
        }
    }

    async cleanup(olderThan: number) {
        return await this.runAsync(
            `delete from ${this.tables.rate_limits} where last_request < ?`,
            [olderThan]
        );
    }
}
