import { applySqlUser } from "./dbUtils";

describe("dbUtils parameter alignment", () => {
    it("should correctly handle '?' inside string literals", () => {
        const sql = "SELECT * FROM memories WHERE content = 'Is this a ?' AND salience > ?";
        const params = [0.5];
        const userId = "user123";

        const { sql: newSql, params: newParams } = applySqlUser(sql, params, userId);

        // Expected:
        // newSql: SELECT * FROM memories WHERE content = 'Is this a ?' AND salience > ? and user_id=?
        // newParams: [0.5, "user123"]



        // CURRENT BROKEN BEHAVIOR:
        // preParamsCount will be 2 (one in string, one placeholder)
        // newParams will be [0.5, undefined, "user123"] or similar misalignment

        const preMatch = newSql.match(/user_id=\?/);
        expect(preMatch).toBeTruthy();

        // If it counts the '?' in the string, it will put userId at index 2
        expect(newParams.length).toBe(2);
        expect(newParams[1]).toBe("user123");
        expect(newParams[0]).toBe(0.5);
    });

    it("should handle '?' in comments", () => {
        const sql = "SELECT * FROM memories WHERE salience > ? -- What about this ?\nORDER BY created_at";
        const params = [0.1];
        const userId = "user123";

        const { sql: newSql, params: newParams } = applySqlUser(sql, params, userId);

        expect(newParams.length).toBe(2);
        expect(newParams[0]).toBe(0.1);
        expect(newParams[1]).toBe("user123");
    });
});
