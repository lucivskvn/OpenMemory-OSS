

import { get_async, all_async, SqlParams } from '../core/db'
import { TemporalFact, TemporalEdge, TemporalQuery, TimelineEntry } from './types'


export function row_to_fact(row: any): TemporalFact {
    if (!row) return null as any;
    return {
        id: row.id,
        user_id: row.user_id || undefined,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        valid_from: new Date(Number(row.valid_from)),
        valid_to: row.valid_to ? new Date(Number(row.valid_to)) : null,
        confidence: row.confidence,
        last_updated: new Date(Number(row.last_updated)),
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || undefined)
    }
}

export function row_to_edge(row: any): TemporalEdge {
    if (!row) return null as any;
    const { TemporalEdge } = require('./types'); // Avoid circular ref if any
    return {
        id: row.id,
        user_id: row.user_id || undefined,
        source_id: row.source_id,
        target_id: row.target_id,
        relation_type: row.relation_type,
        valid_from: new Date(Number(row.valid_from)),
        valid_to: row.valid_to ? new Date(Number(row.valid_to)) : null,
        weight: row.weight,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || undefined)
    }
}

export const query_facts_at_time = async (
    subject?: string,
    predicate?: string,
    object?: string,
    at: Date = new Date(),
    min_confidence: number = 0.1,
    user_id?: string
): Promise<TemporalFact[]> => {
    const timestamp = at.getTime()
    const conditions: string[] = []
    const params: SqlParams = []

    // Build WHERE clause
    conditions.push('(valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))')
    params.push(timestamp, timestamp)

    if (subject) {
        conditions.push('subject = ?')
        params.push(subject)
    }

    if (predicate) {
        conditions.push('predicate = ?')
        params.push(predicate)
    }

    if (object) {
        conditions.push('object = ?')
        params.push(object)
    }

    if (min_confidence > 0) {
        conditions.push('confidence >= ?')
        params.push(min_confidence)
    }

    if (user_id) {
        conditions.push('user_id = ?')
        params.push(user_id)
    } else {
        conditions.push('user_id IS NULL')
    }

    const sql = `
        SELECT *
        FROM temporal_facts
        WHERE ${conditions.join(' AND ')}
        ORDER BY confidence DESC, valid_from DESC
    `

    const rows = await all_async(sql, params)
    return rows.map(row_to_fact)
}


export const get_current_fact = async (
    subject: string,
    predicate: string,
    user_id?: string
): Promise<TemporalFact | null> => {
    const user_clause = user_id ? "user_id = ?" : "user_id IS NULL"
    const user_param = user_id ? [user_id] : []

    const row = await get_async(`
        SELECT *
        FROM temporal_facts
        WHERE subject = ? AND predicate = ? AND ${user_clause} AND valid_to IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
    `, [subject, predicate, ...user_param])

    return row_to_fact(row)
}


export const query_facts_in_range = async (
    subject?: string,
    predicate?: string,
    from?: Date,
    to?: Date,
    min_confidence: number = 0.1,
    user_id?: string
): Promise<TemporalFact[]> => {
    const conditions: string[] = []
    const params: SqlParams = []

    if (from && to) {
        const from_ts = from.getTime()
        const to_ts = to.getTime()
        conditions.push('((valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)) OR (valid_from >= ? AND valid_from <= ?))')
        params.push(to_ts, from_ts, from_ts, to_ts)
    } else if (from) {
        conditions.push('valid_from >= ?')
        params.push(from.getTime())
    } else if (to) {
        conditions.push('valid_from <= ?')
        params.push(to.getTime())
    }

    if (subject) {
        conditions.push('subject = ?')
        params.push(subject)
    }

    if (predicate) {
        conditions.push('predicate = ?')
        params.push(predicate)
    }

    if (min_confidence > 0) {
        conditions.push('confidence >= ?')
        params.push(min_confidence)
    }

    if (user_id) {
        conditions.push('user_id = ?')
        params.push(user_id)
    } else {
        conditions.push('user_id IS NULL')
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `
        SELECT *
        FROM temporal_facts
        ${where}
        ORDER BY valid_from DESC
    `

    const rows = await all_async(sql, params)
    return rows.map(row_to_fact)
}


export const find_conflicting_facts = async (
    subject: string,
    predicate: string,
    at?: Date,
    user_id?: string
): Promise<TemporalFact[]> => {
    const timestamp = at ? at.getTime() : Date.now()
    const user_clause = user_id ? "user_id = ?" : "user_id IS NULL"
    const user_param = user_id ? [user_id] : []

    const rows = await all_async(`
        SELECT *
        FROM temporal_facts
        WHERE subject = ? AND predicate = ?
        AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        AND ${user_clause}
        ORDER BY confidence DESC
    `, [subject, predicate, timestamp, timestamp, ...user_param])

    return rows.map(row_to_fact)
}


export const get_facts_by_subject = async (
    subject: string,
    at?: Date,
    include_historical: boolean = false,
    user_id?: string
): Promise<TemporalFact[]> => {
    let sql: string
    let params: SqlParams

    const user_clause = user_id ? "user_id = ?" : "user_id IS NULL"
    const user_param = user_id ? [user_id] : []

    if (include_historical) {
        sql = `
            SELECT *
            FROM temporal_facts
            WHERE subject = ? AND ${user_clause}
            ORDER BY predicate ASC, valid_from DESC
        `
        params = [subject, ...user_param]
    } else {
        const timestamp = at ? at.getTime() : Date.now()
        sql = `
            SELECT *
            FROM temporal_facts
            WHERE subject = ?
            AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
            AND ${user_clause}
            ORDER BY predicate ASC, confidence DESC
        `
        params = [subject, timestamp, timestamp, ...user_param]
    }

    const rows = await all_async(sql, params)
    return rows.map(row_to_fact)
}


export const search_facts = async (
    pattern: string,
    field: 'subject' | 'predicate' | 'object' | 'all' = 'all',
    at?: Date,
    limit: number = 100,
    user_id?: string
): Promise<TemporalFact[]> => {
    const timestamp = at ? at.getTime() : Date.now()
    const search_pattern = `%${pattern}%`

    const user_clause = user_id ? "user_id = ?" : "user_id IS NULL"
    const user_param = user_id ? [user_id] : []

    const field_clause = field === 'all'
        ? '(subject LIKE ? OR predicate LIKE ? OR object LIKE ?)'
        : `${field} LIKE ?`

    const field_params = field === 'all'
        ? [search_pattern, search_pattern, search_pattern]
        : [search_pattern]

    const sql = `
        SELECT *
        FROM temporal_facts
        WHERE ${field_clause}
        AND (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        AND ${user_clause}
        ORDER BY confidence DESC, valid_from DESC
        LIMIT ?
    `

    const rows = await all_async(sql, [...field_params, timestamp, timestamp, ...user_param, limit])
    return rows.map(row_to_fact)
}


export const get_related_facts = async (
    fact_id: string,
    relation_type?: string,
    at?: Date,
    user_id?: string
): Promise<Array<{ fact: TemporalFact; relation: string; weight: number }>> => {
    const timestamp = at ? at.getTime() : Date.now()
    const conditions = ['(e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to >= ?))']
    const params: SqlParams = [timestamp, timestamp]

    if (relation_type) {
        conditions.push('e.relation_type = ?')
        params.push(relation_type)
    }

    if (user_id) {
        conditions.push('e.user_id = ?')
        params.push(user_id)
    } else {
        conditions.push('e.user_id IS NULL')
    }

    const sql = `
        SELECT f.*, e.relation_type, e.weight
        FROM temporal_edges e
        JOIN temporal_facts f ON e.target_id = f.id
        WHERE e.source_id = ?
        AND ${conditions.join(' AND ')}
        AND (f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to >= ?))
        AND (${user_id ? "f.user_id = ?" : "f.user_id IS NULL"})
        ORDER BY e.weight DESC, f.confidence DESC
    `

    const fact_user_param = user_id ? [user_id] : []
    const rows = await all_async(sql, [fact_id, ...params, timestamp, timestamp, ...fact_user_param])
    return rows.map(row => ({
        fact: row_to_fact(row),
        relation: row.relation_type,
        weight: row.weight
    }))
}

export const query_edges = async (
    source_id?: string,
    target_id?: string,
    relation_type?: string,
    at?: Date,
    user_id?: string
): Promise<TemporalEdge[]> => {
    const timestamp = at ? at.getTime() : Date.now()
    const conditions = ['(valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))']
    const params: SqlParams = [timestamp, timestamp]

    if (source_id) {
        conditions.push('source_id = ?')
        params.push(source_id)
    }
    if (target_id) {
        conditions.push('target_id = ?')
        params.push(target_id)
    }
    if (relation_type) {
        conditions.push('relation_type = ?')
        params.push(relation_type)
    }

    if (user_id) {
        conditions.push('user_id = ?')
        params.push(user_id)
    } else {
        conditions.push('user_id IS NULL')
    }

    const sql = `SELECT * FROM temporal_edges WHERE ${conditions.join(' AND ')} ORDER BY weight DESC`
    const rows = await all_async(sql, params)
    return rows.map(row_to_edge)
}
