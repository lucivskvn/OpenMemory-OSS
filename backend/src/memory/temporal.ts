import { q } from "../core/db";
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

export const create_fact = async (
    subject: string,
    predicate: string,
    object: string,
    valid_from: number = now(),
    valid_to: number | null = null,
    confidence: number = 1.0,
    metadata: Record<string, any> = {}
) => {
    const id = rid();
    await q.ins_fact.run(id, subject, predicate, object, valid_from, valid_to, confidence, now(), j(metadata));
    return id;
};

export const get_facts = async (
    filters: { subject?: string; predicate?: string; object?: string; valid_at?: number }
): Promise<TemporalFact[]> => {
    const rows = await q.get_facts.all(filters);
    return rows.map((r: any) => ({
        ...r,
        metadata: r.metadata ? JSON.parse(r.metadata) : {}
    }));
};

export const invalidate_fact = async (id: string, valid_to: number = now()) => {
    await q.inv_fact.run(id, valid_to);
};

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
