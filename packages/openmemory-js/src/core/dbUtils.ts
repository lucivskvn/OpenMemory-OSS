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

const scanSql = (sql: string): { insertIdx: number; hasWhere: boolean; preParamsCount: number } => {
    const lower = sql.toLowerCase();
    const len = sql.length;

    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;
    let parenDepth = 0;

    let lastWhereIdx = -1;
    let firstClauseIdx = -1;
    let placeholderCount = 0;
    let preParamsCount = 0;

    const KW_WHERE = "where";
    const KW_GROUP = "group by";
    const KW_ORDER = "order by";
    const KW_LIMIT = "limit";

    const isWordChar = (c: string) => /[a-z0-9_]/i.test(c);

    for (let i = 0; i < len; i++) {
        const char = sql[i];
        const next = sql[i + 1];

        // 1. Handle Comments
        if (inLineComment) {
            if (char === "\n") inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (char === "*" && next === "/") {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (!inSingleQuote && !inDoubleQuote) {
            if (char === "-" && next === "-") {
                inLineComment = true;
                i++;
                continue;
            }
            if (char === "/" && next === "*") {
                inBlockComment = true;
                i++;
                continue;
            }
        }

        // 2. Handle Strings
        if (inSingleQuote) {
            if (char === "'" && next === "'") {
                // Escaped quote ''
                i++;
            } else if (char === "'") {
                inSingleQuote = false;
            }
            continue;
        }
        if (inDoubleQuote) {
            if (char === '"' && next === '"') {
                // Escaped quote ""
                i++;
            } else if (char === '"') {
                inDoubleQuote = false;
            }
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

        // 3. Handle Parentheses
        if (char === "(") {
            parenDepth++;
            continue;
        }
        if (char === ")") {
            if (parenDepth > 0) parenDepth--;
            continue;
        }

        // 4. Handle Placeholders (ONLY when at top level and NOT in string/comment)
        if (char === "?") {
            placeholderCount++;
            continue;
        }

        // 5. Handle Clauses
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
                    const nextC = lower[i + KW_GROUP.length];
                    if (!nextC || !isWordChar(nextC)) matched = true;
                } else if (remaining.startsWith(KW_ORDER)) {
                    const nextC = lower[i + KW_ORDER.length];
                    if (!nextC || !isWordChar(nextC)) matched = true;
                } else if (remaining.startsWith(KW_LIMIT)) {
                    const nextC = lower[i + KW_LIMIT.length];
                    if (!nextC || !isWordChar(nextC)) matched = true;
                }

                if (matched) {
                    firstClauseIdx = i;
                    // Fix preParamsCount at the point we found the first clause
                    preParamsCount = placeholderCount;
                }
            }
        }
    }

    const insertIdx = firstClauseIdx !== -1 ? firstClauseIdx : len;
    if (firstClauseIdx === -1) {
        preParamsCount = placeholderCount;
    }
    const hasWhere = lastWhereIdx !== -1 && lastWhereIdx < insertIdx;

    return { insertIdx, hasWhere, preParamsCount };
};

/**
 * Robustly injects user_id filter into SQL and aligns parameters.
 * Handles complex queries (ORDER BY, LIMIT) correctly.
 * @param tablePrefix Optional table prefix for user_id (e.g. 'm' for 'm.user_id')
 */
export const applySqlUser = (
    sql: string,
    params: SqlParams,
    userId: string | null | undefined,
    tablePrefix?: string
): { sql: string, params: SqlParams } => {
    if (userId === undefined) return { sql, params };

    const { insertIdx, hasWhere, preParamsCount } = scanSql(sql);

    const col = tablePrefix ? `${tablePrefix}.user_id` : "user_id";
    const suffix = userId === null ? `${col} IS NULL` : `${col}=?`;

    let pre = sql.substring(0, insertIdx);
    if (pre.endsWith(" ")) pre = pre.trimEnd();

    const post = sql.substring(insertIdx);
    const connector = hasWhere ? "and" : "where";

    const newSql = `${pre} ${connector} ${suffix} ${post}`;

    if (userId === null) {
        // No parameter to inject because we used "IS NULL"
        return { sql: newSql, params };
    }

    const newParams = [
        ...params.slice(0, preParamsCount),
        userId,
        ...params.slice(preParamsCount)
    ];

    return { sql: newSql, params: newParams };
};

/**
 * Simplified helper to inject user_id filter into SQL.
 * Returns modified SQL string only (for simple queries without complex params).
 * @param sql - Base SQL query
 * @param userId - User ID to filter by (null = IS NULL, undefined = no filter)
 * @returns Modified SQL with user_id filter
 */
export const sqlUser = (
    sql: string,
    userId: string | null | undefined
): string => {
    const result = applySqlUser(sql, [], userId);
    return result.sql;
};

/**
 * Helper to append userId to params array for user-scoped queries.
 * @param params - Original parameters array
 * @param userId - User ID to append (null/undefined = no change)
 * @returns New params array with userId appended if provided
 */
export const pUser = (
    params: SqlParams,
    userId: string | null | undefined
): SqlParams => {
    if (userId === null || userId === undefined) {
        return params;
    }
    return [...params, userId];
};
