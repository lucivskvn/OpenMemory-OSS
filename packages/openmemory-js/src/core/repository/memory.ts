import { BaseRepository } from "./base";
import { MemoryRow, BatchMemoryInsertItem, SectorStat, LogEntry } from "../types";
import { getIsPg, hasVector, toVectorString, vectorStore } from "../db";
import { normalizeUserId } from "../../utils";
import { logger } from "../../utils/logger";
import { calculateDualPhaseDecayMemoryRetention } from "../../ops/dynamics";

export class MemoryRepository extends BaseRepository {
    async insMem(
        id: string, content: string, sector: string, tags: string | null, meta: string | null,
        userId: string | null | undefined, segment: number, simhash: string | null,
        ca: number, ua: number, lsa: number, salience: number, dl: number,
        version: number, dim: number, mv: any, cv: any, fs: number, summary: string | null
    ) {
        const p = [
            id, content, sector, tags, meta, userId ?? null, segment, simhash,
            ca, ua, lsa, salience, dl, version, dim,
            getIsPg() && hasVector ? toVectorString(mv) : mv,
            cv, fs, summary
        ];
        const sql = `insert into ${this.tables.memories}(id,content,primary_sector,tags,metadata,user_id,segment,simhash,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score,generated_summary) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set content=excluded.content,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience`;
        return await this.runAsync(sql, p);
    }

    async insMems(items: BatchMemoryInsertItem[]) {
        if (items.length === 0) return 0;

        const execChunk = async (chunk: BatchMemoryInsertItem[]) => {
            if (getIsPg()) {
                const params: import("../db_utils").SqlValue[] = [];
                const rows: string[] = [];
                let idx = 1;
                for (const item of chunk) {
                    const rowParams = [
                        item.id, item.content, item.primarySector, item.tags, item.metadata,
                        item.userId, item.segment || 0, item.simhash, item.createdAt,
                        item.updatedAt, item.lastSeenAt, item.salience || 0.5,
                        item.decayLambda || 0.05, item.version || 1, item.meanDim,
                        hasVector ? toVectorString(item.meanVec) : item.meanVec,
                        item.compressedVec, item.feedbackScore || 0, item.generatedSummary || null,
                    ];
                    params.push(...(rowParams as import("../db_utils").SqlValue[]));
                    const placeholders = rowParams.map(() => `$${idx++}`).join(",");
                    rows.push(`(${placeholders})`);
                }
                const sql = `insert into ${this.tables.memories}(id,content,primary_sector,tags,metadata,user_id,segment,simhash,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score,generated_summary) values ${rows.join(",")} on conflict(id) do update set content=excluded.content,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience`;
                return await this.runAsync(sql, params);
            } else {
                return await this.transaction.run(async () => {
                    let count = 0;
                    for (const item of chunk) {
                        count += await this.insMem(
                            item.id, item.content, item.primarySector, item.tags, item.metadata,
                            item.userId, item.segment || 0, item.simhash, item.createdAt,
                            item.updatedAt, item.lastSeenAt, item.salience || 0.5,
                            item.decayLambda || 0.05, item.version || 1, item.meanDim,
                            item.meanVec, item.compressedVec, item.feedbackScore || 0,
                            item.generatedSummary || null
                        );
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

    async getMem(id: string, userId?: string | null) {
        return await this.getUser<MemoryRow>(
            `select * from ${this.tables.memories} where id=?`,
            [id],
            userId,
        );
    }

    async getMems(ids: string[], userId?: string | null) {
        const MAX_IDS = 5000;
        if (ids.length > MAX_IDS) {
            throw new Error(`[MemoryRepository] Security: too many IDs requested (${ids.length}). Limit: ${MAX_IDS}`);
        }
        if (ids.length === 0) return [];
        return await this.allUser<MemoryRow>(
            `select * from ${this.tables.memories} where id IN (${ids.map(() => "?").join(",")})`,
            [...ids],
            userId,
        );
    }

    async delMem(id: string, userId?: string | null) {
        const res = await this.transaction.run(async () => {
            await this.runUser(
                `delete from ${this.tables.vectors} where id=?`,
                [id],
                userId,
            );
            await this.runUser(
                `delete from ${this.tables.waypoints} where src_id=? or dst_id=?`,
                [id, id],
                userId,
            );
            return await this.runUser(
                `delete from ${this.tables.memories} where id=?`,
                [id],
                userId,
            );
        });

        try {
            await vectorStore.deleteVectors([id], userId);
        } catch (e) {
            logger.warn(`[DB] Failed to cleanup vectors for memory ${id}:`, { error: e });
        }
        return res;
    }

    async getStats(userId?: string | null) {
        return await this.getUser<{ count: number; avgSalience: number }>(
            `select count(*) as count, avg(salience) as avgSalience from ${this.tables.memories}`,
            [],
            userId,
        );
    }

    async getSectorStats(userId?: string | null) {
        return await this.allUser<SectorStat>(`select type as sector, sum(count) as count, 0 as avgSalience from ${this.tables.stats} where type like 'sector:%' group by type`, [], userId);
    }

    async getRecentActivity(limit = 10, userId?: string | null) {
        return await this.allUser<{ id: string; content: string; lastSeenAt: number; primarySector: string; }>(`select id, content, last_seen_at as lastSeenAt, primary_sector as primarySector from ${this.tables.memories} order by last_seen_at desc limit ?`, [limit], userId);
    }

    async getTopMemories(limit = 10, userId?: string | null) {
        return await this.allUser<{ id: string; content: string; salience: number; primarySector: string; }>(`select id, content, salience, primary_sector as primarySector from ${this.tables.memories} order by salience desc limit ?`, [limit], userId);
    }

    async updMeanVec(id: string, dim: number, vec: Buffer | Uint8Array, userId?: string | null) {
        return await this.runUser(`update ${this.tables.memories} set mean_dim=?, mean_vec=? where id=?`, [dim, getIsPg() && hasVector ? toVectorString(vec) : vec, id], userId);
    }

    async updCompressedVec(id: string, vec: Buffer | Uint8Array, userId?: string | null) {
        return await this.runUser(`update ${this.tables.memories} set compressed_vec=? where id=?`, [vec, id], userId);
    }

    async updFeedback(id: string, feedbackScore: number, userId?: string | null) {
        return await this.runUser(`update ${this.tables.memories} set feedback_score=? where id=?`, [feedbackScore, id], userId);
    }

    async updSeen(id: string, lastSeenAt: number, salience: number, updatedAt: number, userId?: string | null) {
        return await this.runUser(`update ${this.tables.memories} set last_seen_at=?, salience=?, updated_at=? where id=?`, [lastSeenAt, salience, updatedAt, id], userId);
    }

    async updSaliences(updates: Array<{ id: string; salience: number; lastSeenAt: number; updatedAt: number; }>, userId?: string | null) {
        if (updates.length === 0) return 0;
        const uid = normalizeUserId(userId);
        if (getIsPg()) {
            const rows: string[] = [];
            const params: (string | number | null)[] = [];
            let idx = 1;
            for (const item of updates) {
                params.push(item.id, item.salience, item.lastSeenAt, item.updatedAt);
                rows.push(`($${idx++}::uuid, $${idx++}::double precision, $${idx++}::bigint, $${idx++}::bigint)`);
            }
            params.push(uid ?? null);
            const sql = `UPDATE ${this.tables.memories} AS m SET salience = u.ns, last_seen_at = u.nl, updated_at = u.nu FROM (VALUES ${rows.join(",")}) AS u(id, ns, nl, nu) WHERE m.id = u.id AND (m.user_id = $${idx} OR (m.user_id IS NULL AND $${idx} IS NULL))`;
            return await this.runAsync(sql, params);
        } else {
            return await this.transaction.run(async () => {
                let count = 0;
                for (const item of updates) {
                    count += await this.updSeen(item.id, item.lastSeenAt, item.salience, item.updatedAt, uid);
                }
                return count;
            });
        }
    }

    async updSummary(id: string, summary: string, userId?: string | null) {
        return await this.runUser(`update ${this.tables.memories} set generated_summary=? where id=?`, [summary, id], userId);
    }

    async updSector(id: string, sector: string, userId?: string | null) {
        return await this.runUser(`update ${this.tables.memories} set primary_sector=? where id=?`, [sector, id], userId);
    }

    async updMem(content: string, sector: string, tags: string | null, meta: string | null, ua: number, id: string, userId?: string | null) {
        return await this.runUser(`update ${this.tables.memories} set content=?, primary_sector=?, tags=?, metadata=?, updated_at=?, version=version+1 where id=?`, [content, sector, tags, meta, ua, id], userId);
    }

    async getMemBySimhash(simhash: string, userId?: string | null) {
        return await this.getUser<MemoryRow>(`select * from ${this.tables.memories} where simhash=? order by salience desc limit 1`, [simhash], userId);
    }

    async allMemCursor(limit: number, cursor: { createdAt: number; id: string } | null, userId?: string | null) {
        if (!cursor) return await this.allUser<MemoryRow>(`select * from ${this.tables.memories} order by created_at desc, id desc limit ?`, [limit], userId);
        return await this.allUser<MemoryRow>(`select * from ${this.tables.memories} where (created_at < ?) OR (created_at = ? AND id < ?) order by created_at desc, id desc limit ?`, [cursor.createdAt, cursor.createdAt, cursor.id, limit], userId);
    }

    async searchByKeyword(keyword: string, limit: number, userId?: string | null) {
        return await this.allUser<MemoryRow>(
            `select * from ${this.tables.memories} where content like ? or tags like ? order by salience desc limit ?`,
            [`%${keyword}%`, `%${keyword}%`, limit],
            userId,
        );
    }

    async hsgSearch(
        ids: string[],
        userId: string | null | undefined,
        limit: number,
        startTime?: number,
        endTime?: number,
        minSalience?: number,
        tau: number = 0.5
    ) {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => "?").join(",");
        const params: any[] = [...ids];
        const uid = normalizeUserId(userId);

        let filterSql = "";
        if (startTime) {
            filterSql += " and created_at >= ?";
            params.push(startTime);
        }
        if (endTime) {
            filterSql += " and created_at <= ?";
            params.push(endTime);
        }

        const now = Date.now();
        const dayMs = 86400000;

        // Note: For complex scoring like calculateDualPhaseDecayMemoryRetention and recency sigmoid,
        // we might do a two-pass: fetch filtered candidates, then score in-memory,
        // OR implement a simplified version in SQL for initial ranking.
        // For now, let's fetch the data we need efficiently.

        const sql = `select * from ${this.tables.memories} where id in (${placeholders}) ${filterSql}`;
        const rows = await this.allUser<MemoryRow>(sql, params, uid);

        // Secondary filtering for minSalience which depends on decay
        if (minSalience) {
            return rows.filter(m => {
                const age = (now - (m.lastSeenAt || 0)) / dayMs;
                const sal = calculateDualPhaseDecayMemoryRetention(m.salience || 0.5, age, m.decayLambda);
                return sal >= minSalience;
            }).slice(0, limit);
        }

        return rows.slice(0, limit);
    }

    async getSegmentCount(segment: number, userId?: string | null): Promise<{ c: number }> {
        const res = await this.getUser<{ c: number }>(`select count(*) as c from ${this.tables.memories} where segment=?`, [segment], userId);
        return res || { c: 0 };
    }

    async getMemCount(userId?: string | null): Promise<{ c: number }> {
        const res = await this.getUser<{ c: number }>(`select count(*) as c from ${this.tables.memories}`, [], userId);
        return res || { c: 0 };
    }

    async getSectorTimeline(sec: string, limit: number, userId?: string | null) {
        return await this.allUser<{ lastSeenAt: number; salience: number }>(`select last_seen_at as lastSeenAt, salience from ${this.tables.memories} where primary_sector=? order by last_seen_at desc limit ?`, [sec, limit], userId);
    }

    async getMemBySegment(seg: number, userId?: string | null) {
        return await this.allUser<MemoryRow>(`select * from ${this.tables.memories} where segment=? order by created_at desc`, [seg], userId);
    }

    async getSegments(userId?: string | null) {
        return await this.allUser<{ segment: number }>(`select distinct segment from ${this.tables.memories} order by segment desc`, [], userId);
    }

    async getMaxSegment(userId?: string | null): Promise<{ maxSeg: number }> {
        const res = await this.getUser<{ maxSeg: number }>(`select coalesce(max(segment), 0) as maxSeg from ${this.tables.memories}`, [], userId);
        return res || { maxSeg: 0 };
    }

    async allMemByUser(uid: string, limit: number, offset: number) {
        return await this.allUser<MemoryRow>(`select * from ${this.tables.memories} order by created_at desc limit ? offset ?`, [limit, offset], uid);
    }

    async allMem(limit: number, offset: number, userId?: string | null) {
        return await this.allUser<MemoryRow>(`select * from ${this.tables.memories} order by created_at desc limit ? offset ?`, [limit, offset], userId);
    }

    async allMemStable(limit: number, offset: number, userId?: string | null) {
        return await this.allUser<MemoryRow>(`select * from ${this.tables.memories} order by created_at desc, id asc limit ? offset ?`, [limit, offset], userId);
    }

    async allMemBySector(sec: string, limit: number, offset: number, userId?: string | null) {
        return await this.allUser<MemoryRow>(`select * from ${this.tables.memories} where primary_sector=? order by created_at desc limit ? offset ?`, [sec, limit, offset], userId);
    }

    async allMemBySectorAndTag(sec: string, tag: string, limit: number, offset: number, userId?: string | null) {
        return await this.allUser<MemoryRow>(`select * from ${this.tables.memories} where primary_sector=? and tags like ? order by created_at desc limit ? offset ?`, [sec, `%${tag}%`, limit, offset], userId);
    }

    async getVecCount(userId?: string | null): Promise<{ c: number }> {
        const res = await this.getUser<{ c: number }>(`select count(*) as c from ${this.tables.vectors}`, [], userId);
        return res || { c: 0 };
    }

    async delMemByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.memories} where user_id=?`, [userId]);
    }

    async delMems(ids: string[], userId?: string | null) {
        if (ids.length === 0) return 0;
        return await this.transaction.run(async () => {
            let count = 0;
            for (const id of ids) {
                count += await this.delMem(id, userId);
            }
            return count;
        });
    }
}
