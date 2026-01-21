import { BaseRepository } from "./base";
import { parseJSON } from "../../utils";

export class IdeRepository extends BaseRepository {
    /**
     * Retrieves the active session start memory for a given session ID.
     */
    async getActiveSession(sessionId: string, userId?: string | null) {
        const uid = this.normalizeUid(userId);
        let sql = "";
        let params: any[] = [];

        if (this.isPg) {
            // Postgres JSONB query
            let idx = 1;
            sql = `SELECT * FROM ${this.tables.memories} WHERE metadata->>'ideSessionId' = $${idx++} AND metadata->>'sessionType' = 'ide_session'`;
            params = [sessionId];
            if (uid) {
                sql += ` AND user_id = $${idx++}`;
                params.push(uid);
            }
        } else {
            // SQLite LIKE query generic match, then filter
            sql = `SELECT * FROM ${this.tables.memories} WHERE metadata LIKE ?`;
            params = [`%${sessionId}%`];
            if (uid) {
                sql += ` AND user_id = ?`;
                params.push(uid);
            }
        }

        sql += " ORDER BY created_at DESC LIMIT 10"; // Limit just in case

        const rows = await this.allAsync<any>(sql, params);

        // Find the exact match
        const session = rows.find(r => {
            const meta = typeof r.metadata === 'string' ? parseJSON(r.metadata) : r.metadata;
            return meta && meta.ideSessionId === sessionId && meta.sessionType === 'ide_session';
        });

        return session || null;
    }
}
