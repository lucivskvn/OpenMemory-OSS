import { BaseRepository } from "./base";
import type { TemporalFactRow, TemporalEdgeRow, TemporalQuery } from "../types/temporal";
import type { SectorType } from "../types/primitives";
import { applySqlUser } from "../dbUtils";

export class TemporalRepository extends BaseRepository {
    // --- Batch / User Management ---

    /**
     * Delete all temporal facts for a specific user.
     */
    async delFactsByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.temporal_facts} where user_id=?`, [userId]);
    }

    /**
     * Delete all temporal edges for a specific user.
     */
    async delEdgesByUser(userId: string) {
        return await this.runAsync(`delete from ${this.tables.temporal_edges} where user_id=?`, [userId]);
    }

    /**
     * Count total facts for a user.
     */
    async getFactCount(userId?: string | null): Promise<{ c: number }> {
        const res = await this.getUser<{ c: number }>(`select count(*) as c from ${this.tables.temporal_facts}`, [], userId);
        return res || { c: 0 };
    }

    /**
     * Count total edges for a user.
     */
    async getEdgeCount(userId?: string | null): Promise<{ c: number }> {
        const res = await this.getUser<{ c: number }>(`select count(*) as c from ${this.tables.temporal_edges}`, [], userId);
        return res || { c: 0 };
    }

    /**
     * Count currently active facts (not invalidated).
     */
    async getActiveFactCount(userId?: string | null): Promise<{ c: number }> {
        const res = await this.getUser<{ c: number }>(`select count(*) as c from ${this.tables.temporal_facts} where valid_to is null`, [], userId);
        return res || { c: 0 };
    }

    /**
     * Count currently active edges (not invalidated).
     */
    async getActiveEdgeCount(userId?: string | null): Promise<{ c: number }> {
        const res = await this.getUser<{ c: number }>(`select count(*) as c from ${this.tables.temporal_edges} where valid_to is null`, [], userId);
        return res || { c: 0 };
    }

    // --- Facts ---

    /**
     * Find the currently active fact matching the triplet.
     * Uses row locking (FOR UPDATE) if on Postgres to ensure consistency during updates.
     */
    async findActiveFact(subject: string, predicate: string, object: string, userId: string | null | undefined): Promise<any> {
        return await this.getUser(
            `SELECT id, confidence, valid_from FROM ${this.tables.temporal_facts} WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL` + (this.isPg ? " FOR UPDATE" : ""),
            [subject, predicate, object],
            userId
        );
    }

    /**
     * Update the confidence and metadata of an existing fact.
     */
    async updateFactConfidence(id: string, confidence: number, metadata: Record<string, unknown> | string | null, now: number) {
        const meta: string | null = (typeof metadata === "object" && metadata !== null) ? JSON.stringify(metadata) : (metadata as string | null);
        return await this.runAsync(
            `UPDATE ${this.tables.temporal_facts} SET confidence = ?, last_updated = ?, metadata = ? WHERE id = ?`,
            [confidence, now, meta, id]
        );
    }

    /**
     * Get all active overlapping facts for specific subject/predicate.
     * Used for validFrom conflicts resolution.
     */
    async getOverlappingFacts(subject: string, predicate: string, validFromTs: number, userId: string | null | undefined): Promise<any[]> {
        return await this.allUser(
            `SELECT id, valid_from, valid_to FROM ${this.tables.temporal_facts} WHERE subject = ? AND predicate = ? AND (valid_to IS NULL OR valid_to >= ?) ORDER BY valid_from ASC` + (this.isPg ? " FOR UPDATE" : ""),
            [subject, predicate, validFromTs],
            userId
        );
    }

    /**
     * Invalidate a fact by setting valid_to.
     */
    async closeFact(id: string, validTo: number, userId?: string | null) {
        return await this.runUser(
            `UPDATE ${this.tables.temporal_facts} SET valid_to = ? WHERE id = ?`,
            [validTo, id],
            userId
        );
    }

    /**
     * Insert a raw fact record.
     */
    async insertFactRaw(fact: { id: string, userId: string | null, subject: string, predicate: string, object: string, validFrom: number, validTo: number | null, confidence: number, lastUpdated: number, metadata: Record<string, unknown> | string | null }) {
        const meta: string | null = (typeof fact.metadata === "object" && fact.metadata !== null) ? JSON.stringify(fact.metadata) : (fact.metadata as string | null);
        return await this.runAsync(
            `INSERT INTO ${this.tables.temporal_facts} (id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [fact.id, fact.userId, fact.subject, fact.predicate, fact.object, fact.validFrom, fact.validTo, fact.confidence, fact.lastUpdated, meta]
        );
    }

    /**
     * Update arbitrary fields of a fact (internal use).
     */
    async updateFactRaw(id: string, updates: string[], params: any[], userId: string | null | undefined): Promise<number> {
        // Security: Validate column names in updates against allowlist
        const allowedColumns = ['confidence', 'valid_to', 'metadata', 'last_updated'];
        const columnRegex = /^(\w+)\s*=/i;

        for (const update of updates) {
            const match = update.match(columnRegex);
            if (!match || !allowedColumns.includes(match[1].toLowerCase())) {
                throw new Error(`Invalid column in update clause: ${update}`);
            }
        }

        const sql = `UPDATE ${this.tables.temporal_facts} SET ${updates.join(", ")} WHERE id = ?`;
        return await this.runUser(sql, [...params, id], userId);
    }

    /**
     * Get a fact by ID.
     */
    async getFact(id: string, userId: string | null | undefined): Promise<any> {
        return await this.getUser(`SELECT * FROM ${this.tables.temporal_facts} WHERE id = ?`, [id], userId);
    }

    // --- Edges ---

    /**
     * Find active edge between two nodes.
     */
    async findActiveEdge(sourceId: string, targetId: string, relationType: string, userId: string | null | undefined): Promise<any> {
        return await this.getUser(
            `SELECT id, weight, valid_from FROM ${this.tables.temporal_edges} WHERE source_id = ? AND target_id = ? AND relation_type = ? AND valid_to IS NULL` + (this.isPg ? " FOR UPDATE" : ""),
            [sourceId, targetId, relationType],
            userId
        );
    }

    /**
     * Update edge weight and metadata.
     */
    async updateEdgeWeight(id: string, weight: number, metadata: Record<string, unknown> | string | null, now: number) {
        const meta: string | null = (typeof metadata === "object" && metadata !== null) ? JSON.stringify(metadata) : (metadata as string | null);
        return await this.runAsync(
            `UPDATE ${this.tables.temporal_edges} SET weight = ?, metadata = ?, last_updated = ? WHERE id = ?`,
            [weight, meta, now, id]
        );
    }

    /**
     * Get active overlapping edges.
     */
    async getOverlappingEdges(sourceId: string, targetId: string, relationType: string, validFromTs: number, userId: string | null | undefined): Promise<any[]> {
        return await this.allUser(
            `SELECT id, valid_from FROM ${this.tables.temporal_edges} WHERE source_id = ? AND target_id = ? AND relation_type = ? AND valid_to IS NULL` + (this.isPg ? " FOR UPDATE" : ""),
            [sourceId, targetId, relationType],
            userId
        );
    }

    /**
     * Invalidate an edge.
     */
    async closeEdge(id: string, validTo: number, userId?: string | null) {
        return await this.runUser(
            `UPDATE ${this.tables.temporal_edges} SET valid_to = ? WHERE id = ?`,
            [validTo, id],
            userId
        );
    }

    /**
     * Insert raw edge record.
     */
    async insertEdgeRaw(edge: { id: string, userId: string | null, sourceId: string, targetId: string, relationType: string, validFrom: number, validTo: number | null, weight: number, lastUpdated: number, metadata: Record<string, unknown> | string | null }) {
        const meta: string | null = (typeof edge.metadata === "object" && edge.metadata !== null) ? JSON.stringify(edge.metadata) : (edge.metadata as string | null);
        return await this.runAsync(
            `INSERT INTO ${this.tables.temporal_edges} (id, user_id, source_id, target_id, relation_type, valid_from, valid_to, weight, last_updated, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [edge.id, edge.userId, edge.sourceId, edge.targetId, edge.relationType, edge.validFrom, edge.validTo, edge.weight, edge.lastUpdated, meta]
        );
    }

    /**
     * Get edge by ID.
     */
    async getEdge(id: string, userId: string | null | undefined): Promise<any> {
        return await this.getUser(`SELECT * FROM ${this.tables.temporal_edges} WHERE id = ?`, [id], userId);
    }

    /**
     * Update arbitrary edge fields.
     */
    async updateEdgeRaw(id: string, updates: string[], params: any[], userId: string | null | undefined): Promise<number> {
        // Validate column names in updates against allowlist
        const allowedColumns = ['weight', 'confidence', 'metadata', 'last_updated'];
        const columnRegex = /^(\w+)\s*=/i;

        for (const update of updates) {
            const match = update.match(columnRegex);
            if (!match || !allowedColumns.includes(match[1].toLowerCase())) {
                throw new Error(`Invalid column in update clause: ${update}`);
            }
        }

        const sql = `UPDATE ${this.tables.temporal_edges} SET ${updates.join(", ")} WHERE id = ?`;
        return await this.runUser(sql, [...params, id], userId);
    }

    /**
     * Hard delete an edge.
     */
    async deleteEdgeRaw(id: string, userId: string | null | undefined): Promise<number> {
        return await this.runUser(
            `DELETE FROM ${this.tables.temporal_edges} WHERE id = ?`,
            [id],
            userId
        );
    }

    // --- Batch / Maintenance ---

    /**
     * Apply time-based confidence decay to all active facts.
     */
    async applyConfidenceDecay(decayRate: number, now: number, oneDay: number, userId: string | null | undefined) {
        const maxFunc = this.isPg ? "GREATEST" : "MAX";
        return await this.runUser(
            `UPDATE ${this.tables.temporal_facts} 
            SET confidence = ${maxFunc}(0.1, confidence * (1.0 - ? * ((? - last_updated) * 1.0 / ?)))
            WHERE valid_to IS NULL AND confidence > 0.1`,
            [decayRate, now, oneDay],
            userId
        );
    }

    // --- Read/Query Methods ---

    /**
     * Query active facts at a specific point in time.
     */
    async queryFactsAtTime(timestamp: number, subject: string | undefined, predicate: string | undefined, object: string | undefined, minConfidence: number, userId: string | null | undefined): Promise<any[]> {
        let sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))`;
        const params: any[] = [timestamp, timestamp];

        if (subject) { sql += " AND subject = ?"; params.push(subject); }
        if (predicate) { sql += " AND predicate = ?"; params.push(predicate); }
        if (object) { sql += " AND object = ?"; params.push(object); }
        if (minConfidence > 0) { sql += " AND confidence >= ?"; params.push(minConfidence); }

        sql += " ORDER BY confidence DESC, valid_from DESC";
        return await this.allUser(sql, params, userId);
    }

    /**
     * Get the single active fact for a subject-predicate pair.
     */
    async getCurrentFact(subject: string, predicate: string, timestamp: number | undefined, userId: string | null | undefined): Promise<any | undefined> {
        let sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE subject = ? AND predicate = ?`;
        const params: any[] = [subject, predicate];

        if (timestamp !== undefined) {
            sql += " AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))";
            params.push(timestamp, timestamp);
        } else {
            sql += " AND valid_to IS NULL";
        }

        sql += " ORDER BY valid_from DESC LIMIT 1";
        const rows = await this.allUser(sql, params, userId);
        return rows[0];
    }

    /**
     * Advanced query for facts within a time range.
     */
    async queryFactsInRange(from: number | undefined, to: number | undefined, subject: string | undefined, predicate: string | undefined, object: string | undefined, minConfidence: number, limit: number, userId: string | null | undefined): Promise<any[]> {
        let sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE 1=1`;
        const params: any[] = [];

        if (from && to) {
            sql += " AND ((valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)) OR (valid_from >= ? AND valid_from <= ?))";
            params.push(to, from, from, to);
        } else if (from) {
            sql += " AND valid_from >= ?"; params.push(from);
        } else if (to) {
            sql += " AND valid_from <= ?"; params.push(to);
        }

        if (subject) { sql += " AND subject = ?"; params.push(subject); }
        if (predicate) { sql += " AND predicate = ?"; params.push(predicate); }
        if (object) { sql += " AND object = ?"; params.push(object); }
        if (minConfidence > 0) { sql += " AND confidence >= ?"; params.push(minConfidence); }

        sql += " ORDER BY valid_from DESC LIMIT ?";
        params.push(limit);

        return await this.allUser(sql, params, userId);
    }

    /**
     * Find conflicting facts (same subject/predicate, overlapping time) for conflict resolution.
     */
    async findConflictingFacts(subject: string, predicate: string, timestamp: number, userId: string | null | undefined): Promise<any[]> {
        const sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE subject = ? AND predicate = ? AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)) ORDER BY confidence DESC`;
        return await this.allUser(sql, [subject, predicate, timestamp, timestamp], userId);
    }

    /**
     * Get all facts for a subject, optionally including history.
     */
    async getFactsBySubject(subject: string, timestamp: number, includeHistorical: boolean, limit: number, userId: string | null | undefined): Promise<any[]> {
        let sql: string;
        let params: any[];

        if (includeHistorical) {
            sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE subject = ? ORDER BY predicate ASC, valid_from DESC LIMIT ?`;
            params = [subject, limit];
        } else {
            sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE subject = ? AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)) ORDER BY predicate ASC, confidence DESC LIMIT ?`;
            params = [subject, timestamp, timestamp, limit];
        }
        return await this.allUser(sql, params, userId);
    }

    /**
     * Pattern search for facts.
     */
    async searchFacts(pattern: string, type: "subject" | "predicate" | "object" | "all", timestamp: number | undefined, limit: number, userId: string | null | undefined): Promise<any[]> {
        // Escape LIKE wildcards to prevent pattern injection
        const escapedPattern = pattern.replace(/[%_|]/g, '|$&');
        const searchPattern = `%${escapedPattern}%`;
        let fieldClause: string;
        let params: any[];

        if (type === "all") {
            fieldClause = "(subject LIKE ? escape '|' OR predicate LIKE ? escape '|' OR object LIKE ? escape '|')";
            params = [searchPattern, searchPattern, searchPattern];
        } else {
            fieldClause = `${type} LIKE ? escape '|'`;
            params = [searchPattern];
        }
        let timeClause = "";
        if (timestamp !== undefined) {
            timeClause = "AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))";
            params.push(timestamp, timestamp);
        }

        const sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE ${fieldClause} ${timeClause} ORDER BY confidence DESC, valid_from DESC LIMIT ?`;
        params.push(limit);

        return await this.allUser(sql, params, userId);
    }

    /**
     * Get facts related to a specific fact ID via edges.
     */
    async getRelatedFacts(factId: string, relationType: string | undefined, timestamp: number, userId: string | null | undefined): Promise<any[]> {
        const params: any[] = [factId, timestamp, timestamp, timestamp, timestamp];
        let userClause = "";

        if (userId !== undefined) {
            if (userId === null) {
                userClause = "AND e.user_id IS NULL AND f.user_id IS NULL";
            } else {
                userClause = "AND e.user_id = ? AND f.user_id = ?";
                params.push(userId, userId);
            }
        }

        let sql = `
            SELECT f.*, e.relation_type, e.weight
            FROM ${this.tables.temporal_edges} e
            JOIN ${this.tables.temporal_facts} f ON e.target_id = f.id
            WHERE e.source_id = ?
            AND (e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?))
            AND (f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to >= ?))
            ${userClause}
        `;

        if (relationType) {
            sql += " AND e.relation_type = ?";
            params.push(relationType);
        }

        sql += ` ORDER BY e.weight DESC, f.confidence DESC`;
        return await this.allAsync(sql, params);
    }

    /**
     * Query edges with filters.
     */
    async queryEdges(sourceId: string | undefined, targetId: string | undefined, relationType: string | undefined, timestamp: number, limit: number, offset: number, userId: string | null | undefined): Promise<any[]> {
        let sql = `SELECT * FROM ${this.tables.temporal_edges} WHERE (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))`;
        const params: any[] = [timestamp, timestamp];

        if (sourceId) { sql += " AND source_id = ?"; params.push(sourceId); }
        if (targetId) { sql += " AND target_id = ?"; params.push(targetId); }
        if (relationType) { sql += " AND relation_type = ?"; params.push(relationType); }

        sql += " ORDER BY weight DESC LIMIT ? OFFSET ?";
        // Using allUser handles user_id
        return await this.allUser(sql, [...params, limit, offset], userId);
    }

    // --- Analytics (Timeline) ---

    /**
     * Get history of a specific predicate (validity periods).
     */
    async getFactsByPredicate(predicate: string, from: number | undefined, to: number | undefined, userId: string | null | undefined): Promise<any[]> {
        const params: any[] = [predicate];
        let sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE predicate = ?`;

        if (from) {
            sql += " AND valid_from >= ?";
            params.push(from);
        }
        if (to) {
            sql += " AND valid_from <= ?";
            params.push(to);
        }

        sql += " ORDER BY valid_from ASC";
        return await this.allUser(sql, params, userId);
    }

    /**
     * Get all facts that changed (created or invalidated) within a window.
     */
    async getChangesInWindow(from: number, to: number, subject: string | undefined, userId: string | null | undefined): Promise<any[]> {
        let sql = `SELECT * FROM ${this.tables.temporal_facts} WHERE ((valid_from >= ? AND valid_from <= ?) OR (valid_to >= ? AND valid_to <= ?))`;
        const params: any[] = [from, to, from, to];

        if (subject) {
            sql += " AND subject = ?";
            params.push(subject);
        }

        sql += " ORDER BY valid_from ASC";
        return await this.allUser(sql, params, userId);
    }

    /**
     * Identify most volatile facts (frequent changes).
     */
    async getVolatileFacts(subject: string | undefined, limit: number, userId: string | null | undefined): Promise<any[]> {
        let sql = `
            SELECT subject, predicate, COUNT(*) as change_count, AVG(confidence) as avg_confidence
            FROM ${this.tables.temporal_facts}
        `;
        const params: any[] = [];

        if (subject) {
            sql += " WHERE subject = ?";
            params.push(subject);
        }

        const { sql: finalSql, params: finalParams } = applySqlUser(sql, params, userId);
        const fullSql = `${finalSql} GROUP BY subject, predicate HAVING COUNT(*) > 1 ORDER BY change_count DESC, avg_confidence ASC LIMIT ?`;
        return await this.allAsync(fullSql, [...finalParams, limit]);
    }
    /**
     * Get facts for a specific subject and predicate (timeline optimization).
     */
    async getFactsBySubjectAndPredicate(subject: string, predicate: string, userId: string | null | undefined): Promise<any[]> {
        return await this.allUser(
            `SELECT * FROM ${this.tables.temporal_facts} WHERE subject = ? AND predicate = ? ORDER BY valid_from ASC LIMIT 10000`,
            [subject, predicate],
            userId
        );
    }

    /**
     * Delete a fact by ID.
     */
    async deleteFactCascade(id: string, userId: string | null | undefined): Promise<number> {
        return await this.runUser(
            `DELETE FROM ${this.tables.temporal_facts} WHERE id = ?`,
            [id],
            userId
        );
    }

    /**
     * Delete edges connected to a specific node (fact ID or subject).
     */
    async deleteEdgesByNode(nodeId: string, userId: string | null | undefined): Promise<number> {
        return await this.runUser(
            `DELETE FROM ${this.tables.temporal_edges} WHERE source_id = ? OR target_id = ?`,
            [nodeId, nodeId],
            userId
        );
    }
}
