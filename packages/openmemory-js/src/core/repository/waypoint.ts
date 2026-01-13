import { BaseRepository } from "./base";
import { Waypoint, BatchWaypointInsertItem } from "../types";
import { getIsPg, transaction } from "../db";

export class WaypointRepository extends BaseRepository {
    async insWaypoint(src: string, dst: string, userId: string | null | undefined, w: number, ca: number, ua: number) {
        return await this.runAsync(
            `insert into ${this.tables.waypoints}(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?) on conflict(src_id,dst_id,user_id) do update set weight=excluded.weight,updated_at=excluded.updated_at`,
            [src, dst, userId ?? null, w, ca, ua],
        );
    }

    async insWaypoints(items: BatchWaypointInsertItem[]) {
        if (items.length === 0) return 0;
        if (getIsPg()) {
            const params: SqlValue[] = [];
            const rows: string[] = [];
            let idx = 1;
            for (const item of items) {
                const rowParams = [item.srcId, item.dstId, item.userId ?? null, item.weight, item.createdAt, item.updatedAt];
                params.push(...rowParams);
                const placeholders = rowParams.map(() => `$${idx++}`).join(",");
                rows.push(`(${placeholders})`);
            }
            const sql = `insert into ${this.tables.waypoints}(src_id,dst_id,user_id,weight,created_at,updated_at) values ${rows.join(",")} on conflict(src_id,dst_id,user_id) do update set weight=excluded.weight,updated_at=excluded.updated_at`;
            return await this.runAsync(sql, params);
        } else {
            return await this.transaction.run(async () => {
                let count = 0;
                for (const item of items) {
                    count += await this.insWaypoint(item.srcId, item.dstId, item.userId, item.weight, item.createdAt, item.updatedAt);
                }
                return count;
            });
        }
    }

    async getNeighbors(src: string, userId?: string | null) {
        return await this.allUser<{ dstId: string; weight: number }>(
            `select dst_id as dstId, weight from ${this.tables.waypoints} where src_id=? order by weight desc`,
            [src],
            userId,
        );
    }

    async getWaypoint(src: string, dst: string, userId?: string | null) {
        return await this.getUser<Waypoint>(
            `select * from ${this.tables.waypoints} where src_id=? and dst_id=?`,
            [src, dst],
            userId,
        );
    }

    async getWaypointsBySrc(src: string, userId?: string | null) {
        return await this.allUser<Waypoint>(
            `select * from ${this.tables.waypoints} where src_id=? order by weight desc`,
            [src],
            userId,
        );
    }

    async updWaypoint(src: string, dst: string, userId: string | null | undefined, weight: number, ua: number) {
        return await this.runUser(
            `update ${this.tables.waypoints} set weight=?, updated_at=? where src_id=? and dst_id=?`,
            [weight, ua, src, dst],
            userId,
        );
    }

    async pruneWaypoints(threshold: number, userId?: string | null) {
        return await this.runUser(
            `delete from ${this.tables.waypoints} where weight<?`,
            [threshold],
            userId,
        );
    }

    async getLowSalienceMemories(threshold: number, limit: number, userId?: string | null) {
        return await this.allUser<{ id: string }>(
            `select id from ${this.tables.memories} where salience < ? order by salience asc limit ?`,
            [threshold, limit],
            userId,
        );
    }

    async delOrphanWaypoints() {
        return await this.runAsync(
            `delete from ${this.tables.waypoints} where src_id not in (select id from ${this.tables.memories}) or dst_id not in (select id from ${this.tables.memories})`,
        );
    }

    async delWaypointsByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.waypoints} where user_id=?`, [userId]);
    }
}
