import { randomUUID } from "node:crypto";
import { all_async, run_async, get_async, transaction } from "../core/db";
import { env } from "../core/config";
import { TemporalFact, TemporalEdge } from "./types";
import { clamp_f } from "../utils/math";

const is_pg = !!env.OM_POSTGRES_URL;

export interface FactOptions {
    subject: string;
    predicate: string;
    object: string;
    valid_from?: Date;
    confidence?: number;
    metadata?: Record<string, any>;
    user_id: string;
    project_id?: string;
}

export async function insert_fact(
    subject: string,
    predicate: string,
    object: string,
    valid_from?: Date,
    confidence?: number,
    metadata?: Record<string, any>,
    user_id?: string,
    project_id?: string,
): Promise<string>;
export async function insert_fact(opts: FactOptions): Promise<string>;
export async function insert_fact(
    subject_or_opts: string | FactOptions,
    predicate?: string,
    object?: string,
    valid_from?: Date,
    confidence?: number,
    metadata?: Record<string, any>,
    user_id?: string,
    project_id?: string,
): Promise<string> {
    if (typeof subject_or_opts === "object" && subject_or_opts !== null) {
        const opts = subject_or_opts;
        return _insert_fact_impl(
            opts.subject,
            opts.predicate,
            opts.object,
            opts.valid_from ?? new Date(),
            opts.confidence ?? 1.0,
            opts.metadata,
            opts.user_id,
            opts.project_id,
        );
    }
    return _insert_fact_impl(
        subject_or_opts,
        predicate as string,
        object as string,
        valid_from ?? new Date(),
        confidence ?? 1.0,
        metadata,
        user_id,
        project_id,
    );
}

const _insert_fact_impl = async (
    subject: string,
    predicate: string,
    object: string,
    valid_from: Date = new Date(),
    confidence: number = 1.0,
    metadata?: Record<string, any>,
    user_id?: string,
    project_id?: string,
    skip_transaction = false
): Promise<string> => {
    if (!user_id) {
        throw new Error(
            "[SECURITY ALERT] Enforced multi-tenancy rules require a valid user_id context for fact operations.",
        );
    }

    const id = randomUUID();
    const now = Date.now();
    const valid_from_ts = valid_from.getTime();

    // Move existing lookup outside the transaction for better consistency
    const existing = await all_async(
        `
        SELECT id, valid_from FROM temporal_facts
        WHERE subject = ? AND predicate = ? AND valid_to IS NULL AND user_id = ?\${project_id ? " AND (project_id = ? OR project_id = 'system_global' OR project_id IS NULL)" : ""}
        ORDER BY valid_from DESC
    `,
        [
            subject,
            predicate,
            user_id,
            ...(project_id ? [project_id] : []),
        ],
    );

    if (!skip_transaction) await transaction.begin();
    try {
        for (const old of existing) {
            if (old.valid_from < valid_from_ts) {
                await run_async(
                    \`UPDATE temporal_facts SET valid_to = ?, last_updated = ? WHERE id = ?\`,
                    [valid_from_ts - 1, now, old.id],
                );
            }
        }

        await run_async(
            \`
            INSERT INTO temporal_facts (id, user_id, project_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        \`,
            [
                id,
                user_id,
                project_id || null,
                subject,
                predicate,
                object,
                valid_from_ts,
                clamp_f(confidence),
                now,
                metadata ? JSON.stringify(metadata) : null,
            ],
        );
        if (!skip_transaction) await transaction.commit();
        return id;
    } catch (e) {
        if (!skip_transaction) await transaction.rollback();
        throw e;
    }
};

export const update_fact = async (
    id: string,
    confidence?: number,
    metadata?: Record<string, any>,
): Promise<void> => {
    const updates: string[] = [];
    const params: any[] = [];

    if (confidence !== undefined) {
        updates.push("confidence = ?");
        params.push(clamp_f(confidence));
    }

    if (metadata !== undefined) {
        updates.push("metadata = ?");
        params.push(JSON.stringify(metadata));
    }

    updates.push("last_updated = ?");
    params.push(Date.now());

    params.push(id);

    if (updates.length > 0) {
        await run_async(
            \`UPDATE temporal_facts SET \${updates.join(", ")} WHERE id = ?\`,
            params,
        );
    }
};

export const invalidate_fact = async (
    id: string,
    valid_to: Date = new Date(),
): Promise<void> => {
    await run_async(
        \`UPDATE temporal_facts SET valid_to = ?, last_updated = ? WHERE id = ?\`,
        [valid_to.getTime(), Date.now(), id],
    );
};

export const delete_fact = async (id: string): Promise<void> => {
    await run_async(\`DELETE FROM temporal_facts WHERE id = ?\`, [id]);
};

export const insert_edge = async (
    source_id: string,
    target_id: string,
    relation_type: string,
    valid_from: Date = new Date(),
    weight: number = 1.0,
    metadata?: Record<string, any>,
): Promise<string> => {
    const id = randomUUID();
    const valid_from_ts = valid_from.getTime();

    await run_async(
        \`
        INSERT INTO temporal_edges (id, source_id, target_id, relation_type, valid_from, valid_to, weight, metadata)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    \`,
        [
            id,
            source_id,
            target_id,
            relation_type,
            valid_from_ts,
            weight,
            metadata ? JSON.stringify(metadata) : null,
        ],
    );
    return id;
};

export const invalidate_edge = async (
    id: string,
    valid_to: Date = new Date(),
): Promise<void> => {
    await run_async(\`UPDATE temporal_edges SET valid_to = ? WHERE id = ?\`, [
        valid_to.getTime(),
        id,
    ]);
};

export const batch_insert_facts = async (
    facts: Array<{
        subject: string;
        predicate: string;
        object: string;
        valid_from?: Date;
        confidence?: number;
        metadata?: Record<string, any>;
        project_id?: string;
    }>,
    user_id?: string,
    project_id?: string,
): Promise<string[]> => {
    const ids: string[] = [];

    await transaction.begin();
    try {
        for (const fact of facts) {
            const id = await _insert_fact_impl(
                fact.subject,
                fact.predicate,
                fact.object,
                fact.valid_from ?? new Date(),
                fact.confidence ?? 1.0,
                fact.metadata,
                user_id,
                fact.project_id || project_id,
                true // skip inner transaction
            );
            ids.push(id);
        }
        await transaction.commit();
    } catch (error) {
        await transaction.rollback();
        throw error;
    }

    return ids;
};

export const apply_confidence_decay = async (
    decay_rate: number = 0.01,
): Promise<number> => {
    const now = Date.now();
    const one_day = 86400000;

    let changes = 0;

    if (is_pg) {
        const rows = await all_async(
            \`
            UPDATE temporal_facts
            SET confidence = GREATEST(0.1, confidence * (1 - ? * ((? - last_updated) / ?))), last_updated = ?
            WHERE valid_to IS NULL AND confidence > 0.1
            RETURNING 1
        \`,
            [decay_rate, now, one_day, now],
        );
        changes = Array.isArray(rows) ? rows.length : 0;
    } else {
        await run_async(
            \`
            UPDATE temporal_facts
            SET confidence = MAX(0.1, confidence * (1 - ? * ((? - last_updated) / ?))), last_updated = ?
            WHERE valid_to IS NULL AND confidence > 0.1
        \`,
            [decay_rate, now, one_day, now],
        );
        const result = (await get_async(\`SELECT changes() as changes\`)) as any;
        changes = result?.changes || 0;
    }
    return changes;
};

export const get_active_facts_count = async (): Promise<number> => {
    const result = (await get_async(
        \`SELECT COUNT(*) as count FROM temporal_facts WHERE valid_to IS NULL\`,
    )) as any;
    return result?.count || 0;
};

export const get_total_facts_count = async (): Promise<number> => {
    const result = (await get_async(
        \`SELECT COUNT(*) as count FROM temporal_facts\`,
    )) as any;
    return result?.count || 0;
};

export const get_fact_by_id_for_user = async (
    id: string,
    user_id: string,
    project_id?: string,
): Promise<TemporalFact | null> => {
    const params: any[] = [id, user_id];
    let sql = \`SELECT id, user_id, project_id, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata
         FROM temporal_facts WHERE id = ? AND user_id = ?\`;
    if (project_id) {
        sql +=
            " AND (project_id = ? OR project_id = 'system_global' OR project_id IS NULL)";
        params.push(project_id);
    }
    sql += " LIMIT 1";

    const row = await get_async(sql, params);
    if (!row) return null;
    return {
        id: row.id,
        user_id: row.user_id,
        project_id: row.project_id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        valid_from: new Date(row.valid_from),
        valid_to: row.valid_to ? new Date(row.valid_to) : null,
        confidence: row.confidence,
        last_updated: new Date(row.last_updated),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
};
