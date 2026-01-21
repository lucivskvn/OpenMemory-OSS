import { BaseRepository } from "./base";

export class AuditRepository extends BaseRepository {
    async log(params: import("../types").AuditLogParams) {
        return await this.runAsync(
            `insert into ${this.tables.audit_logs}(id, user_id, action, resource_type, resource_id, ip_address, user_agent, metadata, timestamp) values(?,?,?,?,?,?,?,?,?)`,
            [
                params.id,
                params.userId,
                params.action,
                params.resourceType,
                params.resourceId,
                params.ipAddress, // Corrected from params.ip
                params.userAgent,
                params.metadata ? JSON.stringify(params.metadata) : null, // Stringify metadata
                params.timestamp,
            ]
        );
    }

    async query(
        userId: string | null,
        action: string | null,
        resourceType: string | null,
        startTime: number | null,
        endTime: number | null,
        limit: number
    ) {
        let sql = `select * from ${this.tables.audit_logs} where 1=1`;
        const params: any[] = [];

        if (userId) {
            sql += ` and user_id=?`;
            params.push(userId);
        }
        if (action) {
            sql += ` and action=?`;
            params.push(action);
        }
        if (resourceType) {
            sql += ` and resource_type=?`;
            params.push(resourceType);
        }
        if (startTime) {
            sql += ` and timestamp >= ?`;
            params.push(startTime);
        }
        if (endTime) {
            sql += ` and timestamp <= ?`;
            params.push(endTime);
        }

        sql += ` order by timestamp desc limit ?`;
        params.push(limit);

        return await this.allAsync<any>(sql, params);
    }
}
