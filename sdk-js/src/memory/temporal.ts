import { q, TABLE_TF, TABLE_TE, all_async, run_async } from "../core/db";
import { rid, now, j } from "../utils";

export interface TemporalFact {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    valid_from: number;
    valid_to: number | null;
    confidence: number;
    metadata: Record<string, any>;
}

export interface TimelineEntry {
    timestamp: number;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    change_type: 'created' | 'invalidated';
}

/**
 * Creates a new temporal fact.
 * Enforces temporal integrity by invalidating existing open facts with the same subject and predicate
 * that started before this new fact.
 * @param subject The subject of the fact.
 * @param predicate The predicate of the fact.
 * @param object The object of the fact.
 * @param valid_from The timestamp when the fact becomes valid (default: now).
 * @param valid_to The timestamp when the fact becomes invalid (default: null).
 * @param confidence The confidence score of the fact (default: 1.0).
 * @param metadata Additional metadata for the fact.
 * @returns The ID of the created fact.
 */
export const create_fact = async (
    subject: string,
    predicate: string,
    object: string,
    valid_from: number = now(),
    valid_to: number | null = null,
    confidence: number = 1.0,
    metadata: Record<string, any> = {}
) => {
    if (valid_to !== null && valid_to < valid_from) {
        throw new Error("valid_to cannot be less than valid_from");
    }

    const existing = await all_async(`
        SELECT id, valid_from FROM ${TABLE_TF}
        WHERE subject = ? AND predicate = ? AND valid_to IS NULL
        ORDER BY valid_from DESC
    `, [subject, predicate]);

    for (const old of existing) {
        if (old.valid_from < valid_from) {
            const close_time = valid_from - 1;
            await run_async(`UPDATE ${TABLE_TF} SET valid_to = ? WHERE id = ?`, [close_time, old.id]);
        } else if (old.valid_from === valid_from) {
            valid_from += 1;
            const close_time = valid_from - 1;
            await run_async(`UPDATE ${TABLE_TF} SET valid_to = ? WHERE id = ?`, [close_time, old.id]);
        }
    }

    const id = rid();
    await q.ins_fact.run(id, subject, predicate, object, valid_from, valid_to, confidence, now(), j(metadata));
    return id;
};

/**
 * Retrieves temporal facts based on filters.
 * @param filters The filters to apply (subject, predicate, object, valid_at).
 * @returns An array of TemporalFact objects.
 */
export const get_facts = async (
    filters: { subject?: string; predicate?: string; object?: string; valid_at?: number }
): Promise<TemporalFact[]> => {
    const rows = await q.get_facts.all(filters);
    return rows.map((r: any) => ({
        ...r,
        metadata: r.metadata ? JSON.parse(r.metadata) : {}
    }));
};

/**
 * Invalidates a temporal fact by setting its valid_to timestamp.
 * @param id The ID of the fact to invalidate.
 * @param valid_to The timestamp when the fact becomes invalid (default: now).
 */
export const invalidate_fact = async (id: string, valid_to: number = now()) => {
    await q.inv_fact.run(id, valid_to);
};

/**
 * Creates a temporal edge between two facts.
 * @param source_id The ID of the source fact.
 * @param target_id The ID of the target fact.
 * @param relation The type of relation.
 * @param weight The weight of the edge (default: 1.0).
 * @param metadata Additional metadata for the edge.
 * @returns The ID of the created edge.
 */
export const create_edge = async (
    source_id: string,
    target_id: string,
    relation: string,
    weight: number = 1.0,
    metadata: Record<string, any> = {}
) => {
    const id = rid();
    await q.ins_edge.run(id, source_id, target_id, relation, now(), null, weight, j(metadata));
    return id;
};

/**
 * Retrieves all edges originating from a source fact.
 * @param source_id The ID of the source fact.
 * @returns An array of edges.
 */
export const get_edges = async (source_id: string): Promise<any[]> => {
    const rows = await q.get_edges.all(source_id);
    return rows.map((r: any) => ({
        ...r,
        metadata: r.metadata ? JSON.parse(r.metadata) : {}
    }));
};

/**
 * Retrieves facts related to a given fact via edges.
 * @param fact_id The ID of the fact to find relations for.
 * @param relation_type Optional relation type to filter by.
 * @param at Optional timestamp for validity check (default: now).
 * @returns Array of related facts with relation info.
 */
export const get_related_facts = async (
    fact_id: string,
    relation_type?: string,
    at: number = now()
): Promise<Array<{ fact: TemporalFact; relation: string; weight: number }>> => {
    const conditions = ['(e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?))'];
    const params: any[] = [at, at];

    if (relation_type) {
        conditions.push('e.relation_type = ?');
        params.push(relation_type);
    }

    const sql = `
        SELECT f.*, e.relation_type, e.weight
        FROM ${TABLE_TE} e
        JOIN ${TABLE_TF} f ON e.target_id = f.id
        WHERE e.source_id = ?
        AND ${conditions.join(' AND ')}
        AND (f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to >= ?))
        ORDER BY e.weight DESC, f.confidence DESC
    `;

    const rows = await all_async(sql, [fact_id, ...params, at, at]);
    return rows.map((r: any) => ({
        fact: {
            id: r.id,
            subject: r.subject,
            predicate: r.predicate,
            object: r.object,
            valid_from: r.valid_from,
            valid_to: r.valid_to,
            confidence: r.confidence,
            metadata: r.metadata ? JSON.parse(r.metadata) : {}
        },
        relation: r.relation_type,
        weight: r.weight
    }));
};

/**
 * Searches for facts matching a pattern.
 * @param pattern The pattern to search for (LIKE %pattern%).
 * @param field The field to search in ('subject', 'predicate', 'object').
 * @param at Optional timestamp for validity check (default: now).
 */
export const search_facts = async (
    pattern: string,
    field: 'subject' | 'predicate' | 'object' = 'subject',
    at: number = now()
): Promise<TemporalFact[]> => {
    if (!['subject', 'predicate', 'object'].includes(field)) {
        throw new Error("Invalid search field. Must be one of 'subject', 'predicate', 'object'.");
    }

    const search_pattern = `%${pattern}%`;
    const sql = `
        SELECT id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
        FROM ${TABLE_TF}
        WHERE ${field} LIKE ?
        AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        ORDER BY confidence DESC, valid_from DESC
        LIMIT 100
    `;

    const rows = await all_async(sql, [search_pattern, at, at]);
    return rows.map((r: any) => ({
        id: r.id,
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
        confidence: r.confidence,
        metadata: r.metadata ? JSON.parse(r.metadata) : {}
    }));
};

export const get_subject_timeline = async (
    subject: string,
    predicate?: string
): Promise<TimelineEntry[]> => {
    const conditions = ['subject = ?'];
    const params: any[] = [subject];

    if (predicate) {
        conditions.push('predicate = ?');
        params.push(predicate);
    }

    const sql = `
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM ${TABLE_TF}
        WHERE ${conditions.join(' AND ')}
        ORDER BY valid_from ASC
    `;

    const rows = await all_async(sql, params);
    const timeline: TimelineEntry[] = [];

    for (const row of rows) {
        timeline.push({
            timestamp: row.valid_from,
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            confidence: row.confidence,
            change_type: 'created'
        });

        if (row.valid_to) {
            timeline.push({
                timestamp: row.valid_to,
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                change_type: 'invalidated'
            });
        }
    }

    return timeline.sort((a, b) => a.timestamp - b.timestamp);
};

export const get_changes_in_window = async (
    from: number,
    to: number,
    subject?: string
): Promise<TimelineEntry[]> => {
    const conditions: string[] = [];
    const params: any[] = [];

    if (subject) {
        conditions.push('subject = ?');
        params.push(subject);
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const sql = `
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM ${TABLE_TF}
        WHERE ((valid_from >= ? AND valid_from <= ?) OR (valid_to >= ? AND valid_to <= ?))
        ${where}
        ORDER BY valid_from ASC
    `;

    const rows = await all_async(sql, [from, to, from, to, ...params]);
    const timeline: TimelineEntry[] = [];

    for (const row of rows) {
        if (row.valid_from >= from && row.valid_from <= to) {
            timeline.push({
                timestamp: row.valid_from,
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                change_type: 'created'
            });
        }

        if (row.valid_to && row.valid_to >= from && row.valid_to <= to) {
            timeline.push({
                timestamp: row.valid_to,
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                change_type: 'invalidated'
            });
        }
    }

    return timeline.sort((a, b) => a.timestamp - b.timestamp);
};

export const get_change_frequency = async (
    subject: string,
    predicate: string,
    window_days: number = 30
): Promise<{
    predicate: string;
    total_changes: number;
    avg_duration_ms: number;
    change_rate_per_day: number;
}> => {
    const current_time = now();
    const window_start = current_time - (window_days * 86400000);

    const rows = await all_async(`
        SELECT valid_from, valid_to
        FROM ${TABLE_TF}
        WHERE subject = ? AND predicate = ?
        AND valid_from >= ?
        ORDER BY valid_from ASC
    `, [subject, predicate, window_start]);

    const total_changes = rows.length;
    let total_duration = 0;
    let valid_durations = 0;

    for (const row of rows) {
        if (row.valid_to) {
            total_duration += row.valid_to - row.valid_from;
            valid_durations++;
        }
    }

    const avg_duration_ms = valid_durations > 0 ? total_duration / valid_durations : 0;
    const change_rate_per_day = total_changes / window_days;

    return {
        predicate,
        total_changes,
        avg_duration_ms,
        change_rate_per_day
    };
};

export const compare_time_points = async (
    subject: string,
    time1: number,
    time2: number
): Promise<{
    added: TemporalFact[];
    removed: TemporalFact[];
    changed: Array<{ before: TemporalFact; after: TemporalFact }>;
    unchanged: TemporalFact[];
}> => {
    const facts_t1 = await get_facts({ subject, valid_at: time1 });
    const facts_t2 = await get_facts({ subject, valid_at: time2 });

    const map_t1 = new Map<string, TemporalFact>();
    const map_t2 = new Map<string, TemporalFact>();

    for (const f of facts_t1) {
        map_t1.set(f.predicate, f);
    }

    for (const f of facts_t2) {
        map_t2.set(f.predicate, f);
    }

    const added: TemporalFact[] = [];
    const removed: TemporalFact[] = [];
    const changed: Array<{ before: TemporalFact; after: TemporalFact }> = [];
    const unchanged: TemporalFact[] = [];

    for (const [pred, fact2] of map_t2) {
        const fact1 = map_t1.get(pred);
        if (!fact1) {
            added.push(fact2);
        } else if (fact1.object !== fact2.object || fact1.id !== fact2.id) {
            changed.push({
                before: fact1,
                after: fact2
            });
        } else {
            unchanged.push(fact2);
        }
    }

    for (const [pred, fact1] of map_t1) {
        if (!map_t2.has(pred)) {
            removed.push(fact1);
        }
    }

    return { added, removed, changed, unchanged };
};

export const get_volatile_facts = async (
    subject?: string,
    limit: number = 10
): Promise<Array<{
    subject: string;
    predicate: string;
    change_count: number;
    avg_confidence: number;
}>> => {
    const where = subject ? 'WHERE subject = ?' : '';
    const params = subject ? [subject] : [];

    const sql = `
        SELECT subject, predicate, COUNT(*) as change_count, AVG(confidence) as avg_confidence
        FROM ${TABLE_TF}
        ${where}
        GROUP BY subject, predicate
        HAVING change_count > 1
        ORDER BY change_count DESC, avg_confidence ASC
        LIMIT ?
    `;

    return await all_async(sql, [...params, limit]);
};
