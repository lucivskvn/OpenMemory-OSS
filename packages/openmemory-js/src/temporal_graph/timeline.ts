

import { all_async, SqlParams } from '../core/db'
import { TemporalFact, TimelineEntry } from './types'
import { row_to_fact } from './query'


export const get_subject_timeline = async (
    subject: string,
    predicate?: string,
    user_id?: string
): Promise<TimelineEntry[]> => {
    const conditions = ['subject = ?']
    const params: SqlParams = [subject]

    if (user_id) {
        conditions.push('user_id = ?')
        params.push(user_id)
    } else {
        conditions.push('user_id IS NULL')
    }

    if (predicate) {
        conditions.push('predicate = ?')
        params.push(predicate)
    }

    const sql = `
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM temporal_facts
        WHERE ${conditions.join(' AND ')}
        ORDER BY valid_from ASC
    `

    const rows = await all_async(sql, params)
    const timeline: TimelineEntry[] = []

    for (const row of rows) {
        // Creation event
        timeline.push({
            timestamp: new Date(row.valid_from),
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            confidence: row.confidence,
            change_type: 'created'
        })

        // Invalidation event (if applicable)
        if (row.valid_to) {
            timeline.push({
                timestamp: new Date(row.valid_to),
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                change_type: 'invalidated'
            })
        }
    }

    return timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}


export const get_predicate_timeline = async (
    predicate: string,
    from?: Date,
    to?: Date,
    user_id?: string
): Promise<TimelineEntry[]> => {
    const conditions = ['predicate = ?']
    const params: SqlParams = [predicate]

    if (user_id) {
        conditions.push('user_id = ?')
        params.push(user_id)
    } else {
        conditions.push('user_id IS NULL')
    }

    if (from) {
        conditions.push('valid_from >= ?')
        params.push(from.getTime())
    }

    if (to) {
        conditions.push('valid_from <= ?')
        params.push(to.getTime())
    }

    const sql = `
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM temporal_facts
        WHERE ${conditions.join(' AND ')}
        ORDER BY valid_from ASC
    `

    const rows = await all_async(sql, params)
    const timeline: TimelineEntry[] = []

    for (const row of rows) {
        timeline.push({
            timestamp: new Date(row.valid_from),
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            confidence: row.confidence,
            change_type: 'created'
        })

        if (row.valid_to) {
            timeline.push({
                timestamp: new Date(row.valid_to),
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                change_type: 'invalidated'
            })
        }
    }

    return timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}


export const get_changes_in_window = async (
    from: Date,
    to: Date,
    subject?: string,
    user_id?: string
): Promise<TimelineEntry[]> => {
    const from_ts = from.getTime()
    const to_ts = to.getTime()
    const conditions: string[] = []
    const params: SqlParams = []

    if (user_id) {
        conditions.push('user_id = ?')
        params.push(user_id)
    } else {
        conditions.push('user_id IS NULL')
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''

    const sql = `
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM temporal_facts
        WHERE ((valid_from >= ? AND valid_from <= ?) OR (valid_to >= ? AND valid_to <= ?))
        ${where}
        ORDER BY valid_from ASC
    `

    const rows = await all_async(sql, [from_ts, to_ts, from_ts, to_ts, ...params])
    const timeline: TimelineEntry[] = []

    for (const row of rows) {
        if (row.valid_from >= from_ts && row.valid_from <= to_ts) {
            timeline.push({
                timestamp: new Date(row.valid_from),
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                change_type: 'created'
            })
        }

        if (row.valid_to && row.valid_to >= from_ts && row.valid_to <= to_ts) {
            timeline.push({
                timestamp: new Date(row.valid_to),
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                change_type: 'invalidated'
            })
        }
    }

    return timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}


export const compare_time_points = async (
    subject: string,
    time1: Date,
    time2: Date,
    user_id?: string
): Promise<{
    added: TemporalFact[]
    removed: TemporalFact[]
    changed: Array<{ before: TemporalFact; after: TemporalFact }>
    unchanged: TemporalFact[]
}> => {
    const t1_ts = time1.getTime()
    const t2_ts = time2.getTime()

    const user_clause = user_id ? "user_id = ?" : "user_id IS NULL"
    const user_param = user_id ? [user_id] : []

    // Get all facts for subject at both times
    const facts_t1 = await all_async(`
        SELECT *
        FROM temporal_facts
        WHERE subject = ?
        AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
        AND ${user_clause}
    `, [subject, t1_ts, t1_ts, ...user_param])

    const facts_t2 = await all_async(`
        SELECT *
        FROM temporal_facts
        WHERE subject = ?
        AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
        AND ${user_clause}
    `, [subject, t2_ts, t2_ts, ...user_param])

    const map_t1 = new Map<string, any>()
    const map_t2 = new Map<string, any>()

    for (const f of facts_t1) {
        map_t1.set(f.predicate, f)
    }

    for (const f of facts_t2) {
        map_t2.set(f.predicate, f)
    }

    const added: TemporalFact[] = []
    const removed: TemporalFact[] = []
    const changed: Array<{ before: TemporalFact; after: TemporalFact }> = []
    const unchanged: TemporalFact[] = []

    // Find added and changed
    for (const [pred, fact2] of map_t2) {
        const fact1 = map_t1.get(pred)
        if (!fact1) {
            added.push(row_to_fact(fact2))
        } else if (fact1.object !== fact2.object || fact1.id !== fact2.id) {
            changed.push({
                before: row_to_fact(fact1),
                after: row_to_fact(fact2)
            })
        } else {
            unchanged.push(row_to_fact(fact2))
        }
    }

    // Find removed
    for (const [pred, fact1] of map_t1) {
        if (!map_t2.has(pred)) {
            removed.push(row_to_fact(fact1))
        }
    }

    return { added, removed, changed, unchanged }
}


export const get_change_frequency = async (
    subject: string,
    predicate: string,
    window_days: number = 30,
    user_id?: string
): Promise<{
    predicate: string
    total_changes: number
    avg_duration_ms: number
    change_rate_per_day: number
}> => {
    const now = Date.now()
    const window_start = now - (window_days * 86400000)

    const user_clause = user_id ? "user_id = ?" : "user_id IS NULL"
    const user_param = user_id ? [user_id] : []

    const rows = await all_async(`
        SELECT *
        FROM temporal_facts
        WHERE subject = ? AND predicate = ?
        AND valid_from >= ?
        AND ${user_clause}
        ORDER BY valid_from ASC
    `, [subject, predicate, window_start, ...user_param])

    const total_changes = rows.length
    let total_duration = 0
    let valid_durations = 0

    for (const row of rows) {
        if (row.valid_to) {
            total_duration += row.valid_to - row.valid_from
            valid_durations++
        }
    }

    const avg_duration_ms = valid_durations > 0 ? total_duration / valid_durations : 0
    const change_rate_per_day = total_changes / window_days

    return {
        predicate,
        total_changes,
        avg_duration_ms,
        change_rate_per_day
    }
}


export const get_volatile_facts = async (
    subject?: string,
    limit: number = 10,
    user_id?: string
): Promise<Array<{
    subject: string
    predicate: string
    change_count: number
    avg_confidence: number
}>> => {
    const conds = []
    const params = []
    if (subject) {
        conds.push('subject = ?')
        params.push(subject)
    }
    if (user_id) {
        conds.push('user_id = ?')
        params.push(user_id)
    } else {
        conds.push('user_id IS NULL')
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''

    const sql = `
        SELECT subject, predicate, COUNT(*) as change_count, AVG(confidence) as avg_confidence
        FROM temporal_facts
        ${where}
        GROUP BY subject, predicate
        HAVING change_count > 1
        ORDER BY change_count DESC, avg_confidence ASC
        LIMIT ?
    `

    return await all_async(sql, [...params, limit])
}

