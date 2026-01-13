import { BaseRepository } from "./base";

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
    async updateFactConfidence(id: string, confidence: number, metadata: string | null, now: number) {
        return await this.runAsync(
            `UPDATE ${this.tables.temporal_facts} SET confidence = ?, last_updated = ?, metadata = ? WHERE id = ?`,
            [confidence, now, metadata, id]
        );
    }

    /**
     * Get all active overlapping facts for specific subject/predicate.
     * Used for validFrom conflicts resolution.
     */
    async getOverlappingFacts(subject: string, predicate: string, validFromTs: number, userId: string | null | undefined): Promise<any[]> {
        return await this.allUser(
            `SELECT id, valid_from, valid_to FROM ${this.tables.temporal_facts} WHERE subject = ? AND predicate = ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from ASC` + (this.isPg ? " FOR UPDATE" : ""),
            [subject, predicate, validFromTs],
            userId
        );
    }

    /**
     * Invalidate a fact by setting valid_to.
     */
    async closeFact(id: string, validTo: number) {
        return await this.runAsync(
            `UPDATE ${this.tables.temporal_facts} SET valid_to = ? WHERE id = ?`,
            [validTo, id]
        );
    }

    /**
     * Insert a raw fact record.
     */
    async insertFactRaw(fact: { id: string, userId: string | null, subject: string, predicate: string, object: string, validFrom: number, validTo: number | null, confidence: number, lastUpdated: number, metadata: string | null }) {
        return await this.runAsync(
            `INSERT INTO ${this.tables.temporal_facts} (id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [fact.id, fact.userId, fact.subject, fact.predicate, fact.object, fact.validFrom, fact.validTo, fact.confidence, fact.lastUpdated, fact.metadata]
        );
    }

    /**
     * Update arbitrary fields of a fact (internal use).
     */
    async updateFactRaw(id: string, updates: string[], params: any[], userId: string | null | undefined): Promise<number> {
        let sql = `UPDATE ${this.tables.temporal_facts} SET ${updates.join(", ")} WHERE id = ?`;
        if (userId !== undefined) {
            sql += userId === null ? " AND user_id IS NULL" : " AND user_id = ?";
        }
        const finalParams = [...params, id, ...(userId !== undefined && userId !== null ? [userId] : [])];
        return await this.runAsync(sql, finalParams);
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
    async updateEdgeWeight(id: string, weight: number, metadata: string | null, now: number) {
        return await this.runAsync(
            `UPDATE ${this.tables.temporal_edges} SET weight = ?, metadata = ?, last_updated = ? WHERE id = ?`,
            [weight, metadata, now, id]
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
    async closeEdge(id: string, validTo: number) {
        return await this.runAsync(`UPDATE ${this.tables.temporal_edges} SET valid_to = ? WHERE id = ?`, [validTo, id]);
    }

    /**
     * Insert raw edge record.
     */
    async insertEdgeRaw(edge: { id: string, userId: string | null, sourceId: string, targetId: string, relationType: string, validFrom: number, validTo: number | null, weight: number, lastUpdated: number, metadata: string | null }) {
        return await this.runAsync(
            `INSERT INTO ${this.tables.temporal_edges} (id, user_id, source_id, target_id, relation_type, valid_from, valid_to, weight, last_updated, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [edge.id, edge.userId, edge.sourceId, edge.targetId, edge.relationType, edge.validFrom, edge.validTo, edge.weight, edge.lastUpdated, edge.metadata]
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
        let sql = `UPDATE ${this.tables.temporal_edges} SET ${updates.join(", ")} WHERE id = ?`;
        if (userId !== undefined) {
            sql += userId === null ? " AND user_id IS NULL" : " AND user_id = ?";
        }
        const finalParams = [...params, id, ...(userId !== undefined && userId !== null ? [userId] : [])];
        return await this.runAsync(sql, finalParams);
    }

    /**
     * Hard delete an edge.
     */
    async deleteEdgeRaw(id: string, userId: string | null | undefined): Promise<number> {
        let sql = `DELETE FROM ${this.tables.temporal_edges} WHERE id = ?`;
        const params: any[] = [id];
        if (userId !== undefined) {
            sql += userId === null ? " AND user_id IS NULL" : " AND user_id = ?";
            if (userId !== null) params.push(userId);
        }
        return await this.runAsync(sql, params);
    }

    // --- Batch / Maintenance ---

    /**
     * Apply time-based confidence decay to all active facts.
     */
    async applyConfidenceDecay(decayRate: number, now: number, oneDay: number, userId: string | null | undefined) {
        const maxFunc = this.isPg ? "GREATEST" : "MAX";
        const params: any[] = [decayRate, now, oneDay];
        let userClause = "";

        if (userId !== undefined) {
            userClause = userId === null ? "AND user_id IS NULL" : "AND user_id = ?";
            if (userId !== null) params.push(userId);
        }

        return await this.runAsync(
            `UPDATE ${this.tables.temporal_facts} 
            SET confidence = ${maxFunc}(0.1, confidence * (1.0 - ? * ((? - last_updated) * 1.0 / ?)))
            WHERE valid_to IS NULL AND confidence > 0.1
            ${userClause}`,
            params
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
        const searchPattern = `%${pattern}%`;
        let fieldClause: string;
        let params: any[];

        if (type === "all") {
            fieldClause = "(subject LIKE ? OR predicate LIKE ? OR object LIKE ?)";
            params = [searchPattern, searchPattern, searchPattern];
        } else {
            fieldClause = `${type} LIKE ?`;
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
        let sql = `
            SELECT f.*, e.relation_type, e.weight
            FROM ${this.tables.temporal_edges} e
            JOIN ${this.tables.temporal_facts} f ON e.target_id = f.id
            WHERE e.source_id = ?
            AND (e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?))
            AND (f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to >= ?))
        `;
        const params: any[] = [factId, timestamp, timestamp, timestamp, timestamp];

        if (relationType) {
            sql += " AND e.relation_type = ?";
            params.push(relationType);
        }

        let userClause = "";
        if (userId !== undefined) {
            userClause = userId === null ? "AND e.user_id IS NULL AND f.user_id IS NULL" : "AND e.user_id = ? AND f.user_id = ?";
            if (userId !== null) params.push(userId, userId);
        }

        sql += ` ${userClause} ORDER BY e.weight DESC, f.confidence DESC`;
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
            WHERE 1=1
        `;
        const params: any[] = [];

        if (subject) {
            sql += " AND subject = ?";
            params.push(subject);
        }

        // Manual user clause for GROUP BY query compatibility
        let userClause = "";
        if (userId !== undefined) {
            userClause = userId === null ? "AND user_id IS NULL" : "AND user_id = ?";
            if (userId !== null) params.push(userId);
        }

        sql += ` ${userClause} GROUP BY subject, predicate HAVING COUNT(*) > 1 ORDER BY change_count DESC, avg_confidence ASC LIMIT ?`;
        params.push(limit);

        return await this.allAsync(sql, params);
    }
}
