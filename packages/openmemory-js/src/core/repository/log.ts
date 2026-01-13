import { BaseRepository } from "./base";
import { LogEntry } from "../types";

export class LogRepository extends BaseRepository {
    async insLog(id: string, userId: string | null | undefined, model: string, status: string, ts: number, err: string | null) {
        return await this.runAsync(
            `insert into ${this.tables.embed_logs}(id,user_id,model,status,ts,err) values(?,?,?,?,?,?) on conflict(id) do update set status=excluded.status,err=excluded.err`,
            [id, userId ?? null, model, status, ts, err ?? null],
        );
    }

    async updLog(id: string, status: string, err: string | null) {
        return await this.runAsync(
            `update ${this.tables.embed_logs} set status=?, err=? where id=?`,
            [status, err, id],
        );
    }

    async getPendingLogs(userId?: string | null) {
        return await this.allUser<LogEntry>(
            `select * from ${this.tables.embed_logs} where status='pending' order by ts asc`,
            [],
            userId,
        );
    }

    async getFailedLogs(userId?: string | null) {
        return await this.allUser<LogEntry>(
            `select * from ${this.tables.embed_logs} where status='failed' order by ts desc limit 100`,
            [],
            userId,
        );
    }

    async logMaintOp(op: string, status: string, details: string, ts: number, userId?: string | null) {
        return await this.runAsync(
            `insert into ${this.tables.maint_logs}(op,user_id,status,details,ts) values(?,?,?,?,?)`,
            [op, userId ?? null, status, details, ts],
        );
    }

    async insMaintLog(userId: string | null | undefined, status: string, details: string, ts: number) {
        return await this.runAsync(
            `insert into ${this.tables.maint_logs}(op,user_id,status,details,ts) values('routine',?,?,?,?)`,
            [userId ?? null, status, details, ts],
        );
    }

    async getMaintenanceLogs(limit = 50, userId?: string | null) {
        return await this.allUser<any>(
            `select * from ${this.tables.maint_logs} order by ts desc limit ?`,
            [limit],
            userId,
        );
    }

    async delEmbedLogsByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.embed_logs} where user_id=?`, [userId]);
    }

    async delMaintLogsByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.maint_logs} where user_id=?`, [userId]);
    }
}
