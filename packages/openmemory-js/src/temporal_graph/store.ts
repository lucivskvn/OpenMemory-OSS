import { run_async, get_async, all_async, SqlParams, transaction } from '../core/db'
import { TemporalFact, TemporalEdge } from './types'
import { env } from '../core/cfg'


export const insert_fact = async (
    subject: string,
    predicate: string,
    object: string,
    valid_from: Date = new Date(),
    confidence: number = 1.0,
    metadata?: Record<string, any>,
    user_id?: string
): Promise<string> => {
    const id = globalThis.crypto.randomUUID()
    const now = Date.now()
    const valid_from_ts = valid_from.getTime()

    const user_clause = user_id ? "user_id = ?" : "user_id IS NULL"
    const user_param = user_id ? [user_id] : []

    const existing = await all_async(`
        SELECT id, valid_from FROM temporal_facts 
        WHERE subject = ? AND predicate = ? AND ${user_clause} AND valid_to IS NULL
        ORDER BY valid_from DESC
    `, [subject, predicate, ...user_param])

    for (const old of existing) {
        if (old.valid_from < valid_from_ts) {
            await run_async(`UPDATE temporal_facts SET valid_to = ? WHERE id = ?`, [valid_from_ts - 1, old.id])
            if (env.verbose) {
                console.error(`[TEMPORAL] Closed fact ${old.id} at ${new Date(valid_from_ts - 1).toISOString()}`) // Use stderr for MCP compatibility
            }
        }
    }

    await run_async(`
        INSERT INTO temporal_facts (id, user_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `, [id, user_id || null, subject, predicate, object, valid_from_ts, confidence, now, metadata ? JSON.stringify(metadata) : null])

    if (env.verbose) {
        console.error(`[TEMPORAL] Inserted fact: ${subject} ${predicate} ${object} (from ${valid_from.toISOString()}, confidence=${confidence})`) // Use stderr for MCP compatibility
    }
    return id
}

export const update_fact = async (id: string, user_id?: string | null, confidence?: number, metadata?: Record<string, any>): Promise<void> => {
    const updates: string[] = []
    const params: SqlParams = []

    if (confidence !== undefined) {
        updates.push('confidence = ?')
        params.push(confidence)
    }

    if (metadata !== undefined) {
        updates.push('metadata = ?')
        params.push(JSON.stringify(metadata))
    }

    updates.push('last_updated = ?')
    params.push(Date.now())

    params.push(id)

    let user_condition = user_id ? "user_id = ?" : "user_id IS NULL"
    if (user_id) params.push(user_id)

    if (updates.length > 0) {
        const changes = await run_async(`UPDATE temporal_facts SET ${updates.join(', ')} WHERE id = ? AND ${user_condition}`, params)
        if (changes === 0) {
            console.error(`[TEMPORAL] Update failed: Fact ${id} not found for user ${user_id || 'NULL'}`)
        } else {
            if (env.verbose) {
                console.error(`[TEMPORAL] Updated fact ${id}`)
            }
        }
    }
}

export const invalidate_fact = async (id: string, user_id?: string | null, valid_to: Date = new Date()): Promise<void> => {
    let user_condition = user_id ? "user_id = ?" : "user_id IS NULL"
    const params = [valid_to.getTime(), Date.now(), id]
    if (user_id) params.push(user_id)

    const changes = await run_async(`UPDATE temporal_facts SET valid_to = ?, last_updated = ? WHERE id = ? AND ${user_condition}`, params)
    if (changes > 0) {
        if (env.verbose) {
            console.error(`[TEMPORAL] Invalidated fact ${id} at ${valid_to.toISOString()}`)
        }
    }
}

export const delete_fact = async (id: string, user_id?: string | null): Promise<void> => {
    let user_condition = user_id ? "user_id = ?" : "user_id IS NULL"
    const params: SqlParams = [id]
    if (user_id) params.push(user_id)

    const changes = await run_async(`DELETE FROM temporal_facts WHERE id = ? AND ${user_condition}`, params)
    if (changes > 0) {
        // Also delete related edges (orphans)
        await run_async(`DELETE FROM temporal_edges WHERE (source_id = ? OR target_id = ?) AND ${user_condition}`, [id, id, ...(user_id ? [user_id] : [])])
        if (env.verbose) {
            console.error(`[TEMPORAL] Deleted fact ${id} and related edges`)
        }
    }
}

export const insert_edge = async (
    source_id: string,
    target_id: string,
    relation_type: string,
    valid_from: Date = new Date(),
    weight: number = 1.0,
    metadata?: Record<string, any>,
    user_id?: string
): Promise<string> => {
    const id = globalThis.crypto.randomUUID()
    const valid_from_ts = valid_from.getTime()

    const user_clause = user_id ? "user_id = ?" : "user_id IS NULL"
    const user_param = user_id ? [user_id] : []

    // Invalidate existing edges of same type between same nodes
    const existing = await all_async(`
        SELECT id, valid_from FROM temporal_edges 
        WHERE source_id = ? AND target_id = ? AND relation_type = ? AND ${user_clause} AND valid_to IS NULL
    `, [source_id, target_id, relation_type, ...user_param])

    for (const old of existing) {
        if (old.valid_from < valid_from_ts) {
            await run_async(`UPDATE temporal_edges SET valid_to = ? WHERE id = ?`, [valid_from_ts - 1, old.id])
            if (env.verbose) {
                console.error(`[TEMPORAL] Closed edge ${old.id} at ${new Date(valid_from_ts - 1).toISOString()}`)
            }
        }
    }

    await run_async(`
        INSERT INTO temporal_edges (id, user_id, source_id, target_id, relation_type, valid_from, valid_to, weight, metadata)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `, [id, user_id || null, source_id, target_id, relation_type, valid_from_ts, weight, metadata ? JSON.stringify(metadata) : null])

    if (env.verbose) {
        console.error(`[TEMPORAL] Created edge: ${source_id} --[${relation_type}]--> ${target_id}`)
    }
    return id
}

export const invalidate_edge = async (id: string, user_id?: string | null, valid_to: Date = new Date()): Promise<void> => {
    let user_condition = user_id ? "user_id = ?" : "user_id IS NULL"
    const params = [valid_to.getTime(), id]
    if (user_id) params.push(user_id)

    const changes = await run_async(`UPDATE temporal_edges SET valid_to = ? WHERE id = ? AND ${user_condition}`, params)
    if (changes > 0) {
        if (env.verbose) {
            console.error(`[TEMPORAL] Invalidated edge ${id}`)
        }
    }
}

export const batch_insert_facts = async (facts: Array<{
    subject: string
    predicate: string
    object: string
    valid_from?: Date
    confidence?: number
    metadata?: Record<string, any>
    user_id?: string
}>): Promise<string[]> => {
    const ids: string[] = []

    await transaction.begin()
    try {
        for (const fact of facts) {
            const id = await insert_fact(
                fact.subject,
                fact.predicate,
                fact.object,
                fact.valid_from,
                fact.confidence,
                fact.metadata,
                fact.user_id
            )
            ids.push(id)
        }
        await transaction.commit()
        if (env.verbose) {
            console.log(`[TEMPORAL] Batch inserted ${ids.length} facts`)
        }
    } catch (error) {
        await transaction.rollback()
        throw error
    }

    return ids
}

export const apply_confidence_decay = async (decay_rate: number = 0.01, user_id?: string): Promise<number> => {
    const now = Date.now()
    const one_day = 86400000

    const user_clause = user_id ? "AND user_id = ?" : "AND user_id IS NULL"
    const params = user_id ? [decay_rate, now, one_day, user_id] : [decay_rate, now, one_day]

    const is_pg = env.metadata_backend === "postgres"
    const max_func = is_pg ? "GREATEST" : "MAX"

    const changes = await run_async(`
        UPDATE temporal_facts 
        SET confidence = ${max_func}(0.1, confidence * (1 - ? * ((? - valid_from) / ?)))
        WHERE valid_to IS NULL AND confidence > 0.1
        ${user_clause}
    `, params)

    if (env.verbose) {
        console.log(`[TEMPORAL] Applied confidence decay to ${changes} facts`)
    }
    return changes
}

export const get_active_facts_count = async (user_id?: string): Promise<number> => {
    const user_clause = user_id ? "AND user_id = ?" : "AND user_id IS NULL"
    const params = user_id ? [user_id] : []
    const result = await get_async<{ count: number }>(`SELECT COUNT(*) as count FROM temporal_facts WHERE valid_to IS NULL ${user_clause}`, params)
    return result?.count || 0
}

export const get_total_facts_count = async (user_id?: string): Promise<number> => {
    const user_clause = user_id ? "WHERE user_id = ?" : "WHERE user_id IS NULL"
    const params = user_id ? [user_id] : []
    const result = await get_async<{ count: number }>(`SELECT COUNT(*) as count FROM temporal_facts ${user_clause}`, params)
    return result?.count || 0
}