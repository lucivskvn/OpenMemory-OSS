import { applySqlUser } from "./db_utils";

function testAlignment() {
    console.log("Testing SQL Parameter Alignment...");

    const tests = [
        {
            name: "Placeholder in string literal",
            sql: "SELECT * FROM memories WHERE content = 'Is this a ?' AND salience > ?",
            params: [0.5],
            userId: "user123",
            expectedParams: [0.5, "user123"]
        },
        {
            name: "Placeholder in comments",
            sql: "SELECT * FROM memories WHERE salience > ? -- What about this ?\nORDER BY created_at",
            params: [0.1],
            userId: "user123",
            expectedParams: [0.1, "user123"]
        },
        {
            name: "Escaped quotes in library",
            sql: "SELECT * FROM memories WHERE tags = '{\"key\": \"O''Reilly\"}' AND content LIKE ?",
            params: ["%foo%"],
            userId: "user123",
            expectedParams: ["%foo%", "user123"]
        }
    ];

    let passed = 0;
    for (const t of tests) {
        const { sql: newSql, params: newParams } = applySqlUser(t.sql, t.params, t.userId);
        console.log(`\nTest: ${t.name}`);
        console.log(`Result SQL: ${newSql}`);
        console.log(`Result Params: ${JSON.stringify(newParams)}`);

        const ok = JSON.stringify(newParams) === JSON.stringify(t.expectedParams);
        if (ok) {
            console.log("✅ PASSED");
            passed++;
        } else {
            console.log("❌ FAILED");
            console.log(`Expected: ${JSON.stringify(t.expectedParams)}`);
        }
    }

    console.log(`\nPassed ${passed}/${tests.length} tests.`);
    if (passed < tests.length) process.exit(1);
}

testAlignment();
