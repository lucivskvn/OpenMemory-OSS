import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Memory } from "../../src/core/memory";
import { insertFact, getActiveFactsCount } from "../../src/temporal_graph/store";
import { allAsync, closeDb, TABLES } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";

describe("Temporal Concurrency: Race Condition Prevention", () => {
    let mem: Memory;

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
        process.env.OM_METADATA_BACKEND = "sqlite";
        mem = new Memory();
        await new Promise(r => setTimeout(r, 1000));
    });

    afterAll(async () => {
        await closeDb();
    });

    test("Concurrent insertFact should results in a consistent timeline", async () => {
        const subject = "ConcurrentSubj";
        const predicate = "hasValue";

        // Fire 5 concurrent inserts for the same subject-predicate
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(insertFact(subject, predicate, `Value-${i}`));
        }

        await Promise.all(promises);

        // Verify only 1 is active (valid_to IS NULL)
        const activeCount = await getActiveFactsCount();
        // Since we are inserting for the same S-P, and Cardinality 1 is enforced,
        // we should have exactly one active fact for this subject.
        const activeSql = `SELECT COUNT(*) as count FROM ${TABLES.temporal_facts} WHERE subject = ? AND predicate = ? AND valid_to IS NULL`;
        const result = await allAsync<{ count: number }>(activeSql, [subject, predicate]);
        expect(Number(result[0].count)).toBe(1);

        // Verify total count is 5 (1 active, 4 invalidated)
        const totalSql = `SELECT COUNT(*) as count FROM ${TABLES.temporal_facts} WHERE subject = ? AND predicate = ?`;
        const totalResult = await allAsync<{ count: number }>(totalSql, [subject, predicate]);
        expect(Number(totalResult[0].count)).toBe(5);
    }, 10000);
});
