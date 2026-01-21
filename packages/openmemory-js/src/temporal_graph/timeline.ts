/**
 * @file timeline.ts
 * @description Temporal Knowledge Graph Timeline Analytics for OpenMemory.
 * @audited 2026-01-19
 */
import { q, transaction, allAsync, TABLES } from "../core/db";
import { env } from "../core/cfg";
import { logger } from "../utils/logger";
import { normalizeUserId } from "../utils";
import { rowToFact } from "./query";
import { TemporalFact, TemporalFactRow, TimelineEntry } from "./types";

/**
 * Helper to convert fact rows into a sorted chronological timeline of events.
 */
async function rowsToTimelineEntries(rows: TemporalFactRow[]): Promise<TimelineEntry[]> {
    const timeline: TimelineEntry[] = [];

    for (const row of rows) {
        // Hydrate row to TemporalFact to handle decryption and normalization
        const fact = await rowToFact(row);

        // Creation event
        timeline.push({
            timestamp: Number(fact.validFrom),
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            confidence: fact.confidence,
            changeType: "created",
        });

        // Invalidation event (if applicable)
        if (fact.validTo) {
            timeline.push({
                timestamp: Number(fact.validTo),
                subject: fact.subject,
                predicate: fact.predicate,
                object: fact.object,
                confidence: fact.confidence,
                changeType: "invalidated",
            });
        }
    }

    // Sorting is necessary because different predicates for the same subject can overlap
    return timeline.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Retrieves the chronological timeline of facts associated with a specific subject.
 */
export const getSubjectTimeline = async (
    subject: string,
    predicate?: string,
    userId?: string | null,
): Promise<TimelineEntry[]> => {
    const uid = normalizeUserId(userId);
    let rows: TemporalFactRow[];

    if (predicate) {
        if (env.verbose) logger.debug(`[TEMPORAL] Fetching optimized timeline for ${subject} / ${predicate}`);
        // Use optimized query from repository
        rows = await q.getFactsBySubjectAndPredicate.all(subject, predicate, uid) as TemporalFactRow[];
    } else {
        // Fallback to existing broad query
        rows = await q.getFactsBySubject.all(subject, 0, true, 10000, uid) as TemporalFactRow[];
    }

    return await rowsToTimelineEntries(rows);
};

export const getPredicateTimeline = async (
    predicate: string,
    from?: Date,
    to?: Date,
    userId?: string | null,
): Promise<TimelineEntry[]> => {
    const uid = normalizeUserId(userId);
    const fromTs = from?.getTime();
    const toTs = to?.getTime();

    const rows = await q.getFactsByPredicate.all(predicate, fromTs, toTs, uid) as TemporalFactRow[];
    return await rowsToTimelineEntries(rows);
};

/**
 * Retrieves all factual changes (creations and invalidations) within a specific time window.
 */
export const getChangesInWindow = async (
    from: Date,
    to: Date,
    subject?: string,
    userId?: string | null,
): Promise<TimelineEntry[]> => {
    const fromTs = from.getTime();
    const toTs = to.getTime();
    const uid = normalizeUserId(userId);

    const rows = await q.getChangesInWindow.all(fromTs, toTs, subject, uid) as TemporalFactRow[];

    // Construct timeline but filter events strictly within window (Repo returns facts overlapping window boundary events)
    const timeline: TimelineEntry[] = [];

    for (const row of rows) {
        const rowFrom = Number(row.validFrom);
        const rowTo = row.validTo ? Number(row.validTo) : null;

        if (rowFrom >= fromTs && rowFrom <= toTs) {
            timeline.push({
                timestamp: rowFrom,
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                changeType: "created",
            });
        }

        if (rowTo && rowTo >= fromTs && rowTo <= toTs) {
            timeline.push({
                timestamp: rowTo,
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                changeType: "invalidated",
            });
        }
    }

    return timeline.sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * Compares factual state of a subject between two points in time.
 * Returns added, removed, changed, and unchanged facts.
 */
export const compareTimePoints = async (
    subject: string,
    time1: Date,
    time2: Date,
    userId?: string | null,
): Promise<{
    added: TemporalFact[];
    removed: TemporalFact[];
    changed: Array<{ before: TemporalFact; after: TemporalFact }>;
    unchanged: TemporalFact[];
}> => {
    const t1Ts = time1.getTime();
    const t2Ts = time2.getTime();
    const uid = normalizeUserId(userId);

    // Use transaction for consistency if desired, though snapshot isolation might not be guaranteed across two SELECTs in SQLite without serializable.
    // However, since we are reading historical data, it's likely stable unless active writes are happening.

    return await transaction.run(async () => {
        // Fetch facts at T1 using Repo
        const rowsT1 = await q.queryFactsAtTime.all(t1Ts, subject, undefined, undefined, 0, uid) as TemporalFactRow[];
        // Fetch facts at T2 using Repo
        const rowsT2 = await q.queryFactsAtTime.all(t2Ts, subject, undefined, undefined, 0, uid) as TemporalFactRow[];

        const mapT1 = new Map<string, TemporalFactRow>();
        const mapT2 = new Map<string, TemporalFactRow>();

        for (const f of rowsT1) mapT1.set(f.predicate, f);
        for (const f of rowsT2) mapT2.set(f.predicate, f);

        const added: TemporalFact[] = [];
        const removed: TemporalFact[] = [];
        const changed: Array<{ before: TemporalFact; after: TemporalFact }> = [];
        const unchanged: TemporalFact[] = [];

        // Find added and changed
        for (const [pred, fact2] of mapT2) {
            const fact1 = mapT1.get(pred);
            if (!fact1) {
                added.push(await rowToFact(fact2));
            } else if (fact1.object !== fact2.object || fact1.id !== fact2.id) {
                changed.push({
                    before: await rowToFact(fact1),
                    after: await rowToFact(fact2),
                });
            } else {
                unchanged.push(await rowToFact(fact2));
            }
        }

        // Find removed
        for (const [pred, fact1] of mapT1) {
            if (!mapT2.has(pred)) {
                removed.push(await rowToFact(fact1));
            }
        }

        return { added, removed, changed, unchanged };
    });
};

export const getChangeFrequency = async (
    subject: string,
    predicate: string,
    windowDays: number = 30,
    userId?: string | null,
): Promise<{
    predicate: string;
    totalChanges: number;
    avgDurationMs: number;
    changeRatePerDay: number;
}> => {
    const now = Date.now();
    const windowStart = now - windowDays * 86400000;
    const uid = normalizeUserId(userId);

    // Use getFactsByPredicate with validFrom filter
    const rows = await q.getFactsByPredicate.all(predicate, windowStart, undefined, uid) as TemporalFactRow[];

    // Filter by subject in memory (since getFactsByPredicate doesn't filter subject)
    const validRows = rows.filter(r => r.subject === subject);

    const totalChanges = validRows.length;
    let totalDuration = 0;
    let validDurations = 0;

    for (const row of validRows) {
        if (row.validTo) {
            totalDuration += Number(row.validTo) - Number(row.validFrom);
            validDurations++;
        } else {
            // Integrity: Count active fact from valid_from to now (virtual duration)
            totalDuration += now - Number(row.validFrom);
            validDurations++;
        }
    }

    const avgDurationMs =
        validDurations > 0 ? totalDuration / validDurations : 0;
    const changeRatePerDay = totalChanges / windowDays;

    return {
        predicate,
        totalChanges,
        avgDurationMs,
        changeRatePerDay,
    };
};

export const getVolatileFacts = async (
    subject?: string,
    limit: number = 10,
    userId?: string | null,
): Promise<
    Array<{
        subject: string;
        predicate: string;
        changeCount: number;
        avgConfidence: number;
    }>
> => {
    const uid = normalizeUserId(userId);
    const rows = await q.getVolatileFacts.all(subject, limit, uid) as { subject: string, predicate: string, changeCount: number, avgConfidence: number }[];

    return rows.map((row) => ({
        subject: row.subject,
        predicate: row.predicate,
        changeCount: row.changeCount,
        avgConfidence: row.avgConfidence,
    }));
};
