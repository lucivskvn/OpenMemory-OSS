/**
 * Temporal Knowledge Graph Timeline Analytics for OpenMemory.
 * Provides tools for chronological event streams, state comparison, and volatility tracking.
 */
import { allAsync, SqlParams, SqlValue, TABLES, transaction } from "../core/db";
import { normalizeUserId } from "../utils";
import { rowToFact } from "./query";
import { TemporalFact, TemporalFactRow, TimelineEntry } from "./types";

/**
 * Helper to convert fact rows into a sorted chronological timeline of events.
 */
function rowsToTimelineEntries(rows: TemporalFactRow[]): TimelineEntry[] {
    const timeline: TimelineEntry[] = [];

    for (const row of rows) {
        // Creation event
        timeline.push({
            timestamp: Number(row.validFrom),
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            confidence: row.confidence,
            changeType: "created",
        });

        // Invalidation event (if applicable)
        if (row.validTo) {
            timeline.push({
                timestamp: Number(row.validTo),
                subject: row.subject,
                predicate: row.predicate,
                object: row.object,
                confidence: row.confidence,
                changeType: "invalidated",
            });
        }
    }

    // Sorting is necessary because different predicates for the same subject can overlap, 
    // even though a single predicate timeline is naturally sorted by the SQL order.
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
    const conditions = ["subject = ?"];
    const params: SqlParams = [subject];
    const uid = normalizeUserId(userId);

    if (uid === undefined) {
        // No user filter (Any/System)
    } else if (uid === null) {
        conditions.push("user_id IS NULL");
    } else {
        conditions.push("user_id = ?");
        params.push(uid);
    }

    if (predicate) {
        conditions.push("predicate = ?");
        params.push(predicate);
    }

    const sql = `
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM ${TABLES.temporal_facts}
        WHERE ${conditions.join(" AND ")}
        ORDER BY valid_from ASC
    `;

    const rows = await allAsync<any>(sql, params);
    return rowsToTimelineEntries(rows);
};

export const getPredicateTimeline = async (
    predicate: string,
    from?: Date,
    to?: Date,
    userId?: string | null,
): Promise<TimelineEntry[]> => {
    const conditions = ["predicate = ?"];
    const params: SqlParams = [predicate];
    const uid = normalizeUserId(userId);

    if (uid === undefined) {
        // No filter
    } else if (uid === null) {
        conditions.push("user_id IS NULL");
    } else {
        conditions.push("user_id = ?");
        params.push(uid);
    }

    if (from) {
        conditions.push("valid_from >= ?");
        params.push(from.getTime());
    }

    if (to) {
        conditions.push("valid_from <= ?");
        params.push(to.getTime());
    }

    const sql = `
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM ${TABLES.temporal_facts}
        WHERE ${conditions.join(" AND ")}
        ORDER BY valid_from ASC
    `;

    const rows = await allAsync<any>(sql, params);
    return rowsToTimelineEntries(rows);
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
    const conditions = [
        "((valid_from >= ? AND valid_from <= ?) OR (valid_to >= ? AND valid_to <= ?))",
    ];
    const params: SqlParams = [fromTs, toTs, fromTs, toTs];

    if (subject) {
        conditions.push("subject = ?");
        params.push(subject);
    }

    const uid = normalizeUserId(userId);
    if (uid === undefined) {
        // No filter
    } else if (uid === null) {
        conditions.push("user_id IS NULL");
    } else {
        conditions.push("user_id = ?");
        params.push(uid);
    }

    const sql = `
        SELECT subject, predicate, object, confidence, valid_from, valid_to
        FROM ${TABLES.temporal_facts}
        WHERE ${conditions.join(" AND ")}
        ORDER BY valid_from ASC
    `;

    const rows = await allAsync<TemporalFactRow>(sql, params);
    const timeline: TimelineEntry[] = [];

    for (const row of rows) {
        const rowFrom = Number(row.validFrom);
        const rowTo = row.validTo ? Number(row.validTo) : null;

        // Efficiency: Only push events that actually fall within the window
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

    let userClause = "";
    let userParam: SqlValue[] = [];

    if (uid === undefined) {
        userClause = "1=1"; // No filter
    } else if (uid === null) {
        userClause = "user_id IS NULL";
    } else {
        userClause = "user_id = ?";
        userParam = [uid];
    }

    // Integrity: Use transaction to ensure t1 and t2 queries see the same snapshot version
    return await transaction.run(async () => {
        // Efficiency: Consolidated into a single query to reduce round-trips
        const allFacts = await allAsync<TemporalFactRow>(
            `
            SELECT *
            FROM ${TABLES.temporal_facts}
            WHERE subject = ?
            AND (
                (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
                OR
                (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
            )
            AND ${userClause}
        `,
            [subject, t1Ts, t1Ts, t2Ts, t2Ts, ...userParam],
        );

        const factsT1: TemporalFactRow[] = [];
        const factsT2: TemporalFactRow[] = [];

        for (const f of allFacts) {
            const rowFrom = Number(f.validFrom);
            const rowTo = f.validTo ? Number(f.validTo) : null;

            if (rowFrom <= t1Ts && (rowTo === null || rowTo >= t1Ts)) {
                factsT1.push(f);
            }
            if (rowFrom <= t2Ts && (rowTo === null || rowTo >= t2Ts)) {
                factsT2.push(f);
            }
        }

        const mapT1 = new Map<string, TemporalFactRow>();
        const mapT2 = new Map<string, TemporalFactRow>();

        for (const f of factsT1) {
            mapT1.set(f.predicate, f);
        }

        for (const f of factsT2) {
            mapT2.set(f.predicate, f);
        }

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

    let userClause = "";
    let userParam: SqlValue[] = [];

    if (uid === undefined) {
        userClause = "1=1";
    } else if (uid === null) {
        userClause = "user_id IS NULL";
    } else {
        userClause = "user_id = ?";
        userParam = [uid];
    }

    const rows = await allAsync<TemporalFactRow>(
        `
        SELECT *
        FROM ${TABLES.temporal_facts}
        WHERE subject = ? AND predicate = ?
        AND valid_from >= ?
        AND ${userClause}
        ORDER BY valid_from ASC
    `,
        [subject, predicate, windowStart, ...userParam],
    );

    const totalChanges = rows.length;
    let totalDuration = 0;
    let validDurations = 0;

    for (const row of rows) {
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
    const conds = [];
    const params: SqlParams = [];
    if (subject) {
        conds.push("subject = ?");
        params.push(subject);
    }

    const uid = normalizeUserId(userId);
    if (uid === undefined) {
        // No filter
    } else if (uid === null) {
        conds.push("user_id IS NULL");
    } else {
        conds.push("user_id = ?");
        params.push(uid);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

    const sql = `
        SELECT subject, predicate, COUNT(*) as change_count, AVG(confidence) as avg_confidence
        FROM ${TABLES.temporal_facts}
        ${where}
        GROUP BY subject, predicate
        HAVING change_count > 1
        ORDER BY change_count DESC, avg_confidence ASC
        LIMIT ?
    `;

    const rows = await allAsync<{
        subject: string;
        predicate: string;
        change_count: number;
        avg_confidence: number;
    }>(sql, [...params, limit]);
    return rows.map((row) => ({
        subject: row.subject,
        predicate: row.predicate,
        changeCount: row.change_count,
        avgConfidence: row.avg_confidence,
    }));
};
