import { BaseRepository } from "./base";
import { Waypoint, BatchWaypointInsertItem } from "../types";
import { getIsPg, transaction } from "../db_access";
import { SqlValue } from "../db_utils";

export class WaypointRepository extends BaseRepository {
    /**
     * Inserts a new waypoint or updates the weight of an existing one.
     * @param src Source memory ID.
     * @param dst Destination memory ID.
     * @param userId Owner context for multi-tenant isolation.
     * @param weight Relevance weight (e.g. cosine similarity).
     * @param createdAt Timestamp of creation.
     * @param updatedAt Timestamp of last update.
     */
    async insWaypoint(src: string, dst: string, userId: string | null | undefined, weight: number, createdAt: number, updatedAt: number) {
        const result = await this.runAsync(
            `insert into ${this.tables.waypoints}(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?) on conflict(src_id,dst_id,user_id) do update set weight=excluded.weight,updated_at=excluded.updated_at`,
            [src, dst, userId ?? null, weight, createdAt, updatedAt],
        );
        return typeof result === 'number' ? result : ((result as any)?.changes || 1);
    }

    /**
     * Batch inserts multiple waypoints and updates existing ones on conflict.
     * @param items List of waypoints to insert or update.
     * @returns Number of affected rows.
     */
    async insWaypoints(items: BatchWaypointInsertItem[]) {
        if (items.length === 0) return 0;

        const execChunk = async (chunk: BatchWaypointInsertItem[]) => {
            if (getIsPg()) {
                const params: SqlValue[] = [];
                const rows: string[] = [];
                let idx = 1;
                for (const item of chunk) {
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
                    for (const item of chunk) {
                        count += await this.insWaypoint(item.srcId, item.dstId, item.userId, item.weight, item.createdAt, item.updatedAt);
                    }
                    return count;
                });
            }
        };

        const BATCH_SIZE = 500;
        let total = 0;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            total += await execChunk(items.slice(i, i + BATCH_SIZE));
        }
        return total;
    }

    async list(limit: number, userId?: string | null) {
        return await this.allUser<Waypoint>(
            `select src_id as srcId, dst_id as dstId, weight, created_at as createdAt, updated_at as updatedAt from ${this.tables.waypoints} order by created_at desc limit ?`,
            [limit],
            userId,
        );
    }

    async getNeighbors(src: string, userId?: string | null) {
        return await this.allUser<{ dstId: string; weight: number }>(
            `select dst_id as dstId, weight from ${this.tables.waypoints} where src_id=? order by weight desc`,
            [src],
            userId,
        );
    }

    async getWaypoint(src: string, dst: string, userId?: string | null, lock: boolean = false) {
        let sql = `select * from ${this.tables.waypoints} where src_id=? and dst_id=?`;
        if (lock && getIsPg()) {
            sql += " FOR UPDATE";
        }
        return await this.getUser<Waypoint>(
            sql,
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

    async getWaypointsBySrcs(srcs: string[], userId?: string | null) {
        if (srcs.length === 0) return [];
        return await this.allUser<Waypoint>(
            `select * from ${this.tables.waypoints} where src_id in (${srcs.map(() => "?").join(",")}) order by weight desc`,
            srcs,
            userId,
        );
    }

    async getWaypointsForPairs(pairs: Array<{ src: string; dst: string }>, userId?: string | null, lock: boolean = false) {
        if (pairs.length === 0) return [];
        const uniqueSrcs = Array.from(new Set(pairs.map(p => p.src)));

        // Fetch all waypoints for these source nodes to filter locally
        // This is more efficient than N queries or complex JOIN logic for small batches
        let sql = `select * from ${this.tables.waypoints} where src_id in (${uniqueSrcs.map(() => "?").join(",")})`;
        if (lock && getIsPg()) {
            sql += " FOR UPDATE";
        }
        const all = await this.allUser<Waypoint>(
            sql,
            uniqueSrcs,
            userId,
        );

        const map = new Map<string, Waypoint>();
        for (const wp of all) {
            map.set(`${wp.srcId}:${wp.dstId}`, wp);
        }
        return map;
    }


    /**
     * Updates an existing waypoint weight.
     * @param src Source memory ID.
     * @param dst Destination memory ID.
     * @param userId Owner context.
     * @param weight New weight value.
     * @param updatedAt Timestamp of update.
     */
    async updWaypoint(src: string, dst: string, userId: string | null | undefined, weight: number, updatedAt: number) {
        return await this.runUser(
            `update ${this.tables.waypoints} set weight=?, updated_at=? where src_id=? and dst_id=?`,
            [weight, updatedAt, src, dst],
            userId,
        );
    }

    /**
     * Prunes waypoints with weight below a certain threshold.
     */
    async pruneWaypoints(threshold: number, userId?: string | null) {
        return await this.runUser(
            `delete from ${this.tables.waypoints} where weight<?`,
            [threshold],
            userId,
        );
    }

    /**
     * Finds memories with salience below a threshold (candidates for forgetting).
     */
    async getLowSalienceMemories(threshold: number, limit: number, userId?: string | null) {
        return await this.allUser<{ id: string }>(
            `select id from ${this.tables.memories} where salience < ? order by salience asc limit ?`,
            [threshold, limit],
            userId,
        );
    }

    async delOrphanWaypoints() {
        return await this.runAsync(
            `delete from ${this.tables.waypoints} where 
            NOT EXISTS (select 1 from ${this.tables.memories} m where m.id = ${this.tables.waypoints}.src_id)
            or NOT EXISTS (select 1 from ${this.tables.memories} m where m.id = ${this.tables.waypoints}.dst_id)`,
        );
    }

    async delWaypointsByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.waypoints} where user_id=?`, [userId]);
    }
}
