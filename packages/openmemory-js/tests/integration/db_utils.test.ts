import { describe, expect, test } from "bun:test";
import { sqlUser, pUser, applySqlUser } from "../../src/core/db_utils";

describe("db_utils", () => {
    describe("sqlUser", () => {
        test("injects user_id clause when user is provided", () => {
            const sql = "SELECT * FROM memories";
            const result = sqlUser(sql, "user1");
            expect(result).toBe("SELECT * FROM memories where user_id=? ");
        });

        test("injects user_id IS NULL when user is null", () => {
            const sql = "SELECT * FROM memories";
            const result = sqlUser(sql, null);
            expect(result).toBe("SELECT * FROM memories where user_id IS NULL ");
        });

        test("does nothing when user is undefined", () => {
            const sql = "SELECT * FROM memories";
            const result = sqlUser(sql, undefined);
            expect(result).toBe("SELECT * FROM memories");
        });

        test("appends with AND if WHERE exists", () => {
            const sql = "SELECT * FROM memories WHERE salience > 0.5";
            const result = sqlUser(sql, "user1");
            expect(result).toBe("SELECT * FROM memories WHERE salience > 0.5 and user_id=? ");
        });

        test("inserts before ORDER BY", () => {
            const sql = "SELECT * FROM memories ORDER BY created_at DESC";
            const result = sqlUser(sql, "user1");
            expect(result).toContain("where user_id=? ORDER BY created_at DESC");
        });

        test("inserts before LIMIT", () => {
            const sql = "SELECT * FROM memories LIMIT 10";
            const result = sqlUser(sql, "user1");
            expect(result).toContain("where user_id=? LIMIT 10");
        });

        test("inserts before GROUP BY", () => {
            const sql = "SELECT count(*), sector FROM memories GROUP BY sector";
            const result = sqlUser(sql, "user1");
            expect(result).toContain("where user_id=? GROUP BY sector");
        });

        // Edge Cases & Robustness
        test("handles case insensitivity for keywords", () => {
            const sql = "select * from memories order by created_at";
            const result = sqlUser(sql, "user1");
            expect(result).toContain("where user_id=? order by created_at");
        });

        test("correctly ignores keywords inside subqueries (simple parentheses check)", () => {
            // function logic: counts parens to ensuring we are not inside one
            const sql = "SELECT * FROM (SELECT * FROM memories WHERE x=1) as t";
            const result = sqlUser(sql, "user1");
            // Should append at the end (outer query), or strictly where the outer query allows.
            // Current logic appends at the end if no outer clauses found.
            expect(result).toBe("SELECT * FROM (SELECT * FROM memories WHERE x=1) as t where user_id=? ");
        });

        test("does not get fooled by 'where' in string literals", () => {
            const sql = "SELECT * FROM memories WHERE content LIKE '% where %'";
            const result = sqlUser(sql, "user1");

            // Ideally it should append " and user_id=?"
            expect(result).toContain(" and user_id=? ");
        });
    });

    describe("applySqlUser", () => {
        test("applySqlUser should inject param at correct position with LIMIT", () => {
            const sql = "SELECT * FROM memories WHERE content LIKE ? ORDER BY created_at LIMIT ?";
            const params = ["%foo%", 10];
            const userId = "user123";

            const res = applySqlUser(sql, params, userId);

            // user_id=? should be injected BEFORE Order By/Limit
            // "SELECT * FROM memories WHERE content LIKE ? and user_id=? ORDER BY created_at LIMIT ?"
            expect(res.sql).toMatch(/where content like \? and user_id=\? order by/i);

            // Params should be ["%foo%", "user123", 10]
            expect(res.params).toEqual(["%foo%", "user123", 10]);
        });

        test("applySqlUser should handle no params in pre section", () => {
            const sql = "SELECT * FROM memories LIMIT ?";
            const params = [5];
            const userId = "u1";

            const res = applySqlUser(sql, params, userId);
            expect(res.sql).toMatch(/where user_id=\? limit \?/i);
            expect(res.params).toEqual(["u1", 5]);
        });
    });

    describe("pUser", () => {
        test("appends user_id to params", () => {
            const params = [1, "test"];
            const result = pUser(params, "user1");
            expect(result).toEqual([1, "test", "user1"]);
        });

        test("returns original params if user is null/undefined", () => {
            const params = [1];
            expect(pUser(params, null)).toEqual([1]);
            expect(pUser(params, undefined)).toEqual([1]);
        });
    });
});
