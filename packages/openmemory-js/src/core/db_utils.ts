/**
 * @file SQL Utility functions for OpenMemory.
 * Handles robust SQL scanning and user-scoped parameter injection.
 */
export type SqlValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | Uint8Array;
export type SqlParams = SqlValue[];

interface ScanResult {
    insertIdx: number;
    hasWhere: boolean;
}

const scanSql = (sql: string): ScanResult => {
    // Robust State-Machine Scanner
    const lower = sql.toLowerCase();
    const len = sql.length;

    let inSingleQuote = false;
    let inDoubleQuote = false;
    let parenDepth = 0;

    let lastWhereIdx = -1;
    let firstClauseIdx = -1;

    const KW_WHERE = "where";
    const KW_GROUP = "group by";
    const KW_ORDER = "order by";
    const KW_LIMIT = "limit";

    const isWordChar = (c: string) => /[a-z0-9_]/i.test(c);

    for (let i = 0; i < len; i++) {
        const char = sql[i];

        if (inSingleQuote) {
            if (char === "'" && sql[i - 1] !== "\\") inSingleQuote = false;
            continue;
        }
        if (inDoubleQuote) {
            if (char === '"' && sql[i - 1] !== "\\") inDoubleQuote = false;
            continue;
        }

        if (char === "'") {
            inSingleQuote = true;
            continue;
        }
        if (char === '"') {
            inDoubleQuote = true;
            continue;
        }

        if (char === "(") {
            parenDepth++;
            continue;
        }
        if (char === ")") {
            if (parenDepth > 0) parenDepth--;
            continue;
        }

        if (parenDepth === 0) {
            const lowerChar = char.toLowerCase();
            if (!['w', 'g', 'o', 'l'].includes(lowerChar)) continue;

            const prevChar = i > 0 ? sql[i - 1] : " ";
            if (isWordChar(prevChar)) continue;

            const remaining = lower.substring(i);

            if (remaining.startsWith(KW_WHERE)) {
                const nextChar = lower[i + KW_WHERE.length];
                if (!nextChar || !isWordChar(nextChar)) {
                    lastWhereIdx = i;
                }
            } else if (firstClauseIdx === -1) {
                let matched = false;
                if (remaining.startsWith(KW_GROUP)) {
                    const next = lower[i + KW_GROUP.length];
                    if (!next || !isWordChar(next)) matched = true;
                } else if (remaining.startsWith(KW_ORDER)) {
                    const next = lower[i + KW_ORDER.length];
                    if (!next || !isWordChar(next)) matched = true;
                } else if (remaining.startsWith(KW_LIMIT)) {
                    const next = lower[i + KW_LIMIT.length];
                    if (!next || !isWordChar(next)) matched = true;
                }

                if (matched) {
                    firstClauseIdx = i;
                }
            }
        }
    }

    const insertIdx = firstClauseIdx !== -1 ? firstClauseIdx : len;
    const hasWhere = lastWhereIdx !== -1 && lastWhereIdx < insertIdx;

    return { insertIdx, hasWhere };
};

/**
 * @deprecated Use applySqlUser instead to ensure parameter alignment
 */
export const sqlUser = (sql: string, userId: string | null | undefined) => {
    let suffix = "";
    if (userId === undefined) suffix = "";
    else if (userId === null) suffix = "user_id IS NULL";
    else suffix = "user_id=?";

    if (!suffix) return sql;

    const { insertIdx, hasWhere } = scanSql(sql);

    let pre = sql.substring(0, insertIdx);
    if (pre.endsWith(" ")) pre = pre.trimEnd();

    const post = sql.substring(insertIdx);
    const connector = hasWhere ? "and" : "where";

    return `${pre} ${connector} ${suffix} ${post}`;
};

/**
 * @deprecated Use applySqlUser instead to ensure parameter alignment
 */
export const pUser = (p: SqlParams, userId: string | null | undefined) => {
    if (userId === undefined || userId === null) return p;
    return [...p, userId];
};

/**
 * Robustly injects user_id filter into SQL and aligns parameters.
 * Handles complex queries (ORDER BY, LIMIT) correctly.
 */
export const applySqlUser = (sql: string, params: SqlParams, userId: string | null | undefined): { sql: string, params: SqlParams } => {
    if (userId === undefined) return { sql, params };

    const { insertIdx, hasWhere } = scanSql(sql);

    const suffix = userId === null ? "user_id IS NULL" : "user_id=?";

    let pre = sql.substring(0, insertIdx);
    if (pre.endsWith(" ")) pre = pre.trimEnd();

    const post = sql.substring(insertIdx);
    const connector = hasWhere ? "and" : "where";

    const newSql = `${pre} ${connector} ${suffix} ${post}`;

    if (userId === null) {
        // No parameter to inject because we used "IS NULL"
        return { sql: newSql, params };
    }

    // Determine injection index by counting '?' in 'pre' section
    const preParamsCount = (pre.match(/\?/g) || []).length;

    const newParams = [
        ...params.slice(0, preParamsCount),
        userId,
        ...params.slice(preParamsCount)
    ];

    return { sql: newSql, params: newParams };
};
