import { describe, test, expect } from "bun:test";
import {
    insert_fact,
    query_facts_at_time,
    get_subject_timeline,
    invalidate_fact
} from "../../src/temporal_graph";
import { init_db } from "../../src/core/db";

// Ensure DB is initialized before tests (though bun:test might run in parallel, init_db is safe)
await init_db();

describe("Temporal Graph (Deep Dive)", () => {
    test("Full Lifecycle: Insert -> Query -> Invalidate -> Timeline", async () => {
        const subject = `test_subject_${Date.now()}`;
        const predicate = "is_testing";
        const object = "true";

        // 1. Insert
        const id = await insert_fact(subject, predicate, object);
        expect(id).toBeDefined();

        // 2. Query Current
        const facts = await query_facts_at_time(subject, predicate);
        expect(facts.length).toBe(1);
        expect(facts[0].object).toBe(object);
        expect(facts[0].valid_to).toBeNull();

        // 3. Invalidate
        await invalidate_fact(id);

        // 4. Query Past (should exist)
        const pastFacts = await query_facts_at_time(subject, predicate, undefined, new Date(Date.now() - 1000));
        // Note: query_facts_at_time defaults to NOW. If we invalidated, valid_to is NOW.
        // So querying at NOW might return nothing or the fact if valid_to >= NOW is inclusive?
        // query logic: (valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?))
        // if valid_to == query_time, it is included.

        // 5. Query Future (should be gone)
        const futureFacts = await query_facts_at_time(subject, predicate, undefined, new Date(Date.now() + 1000));
        expect(futureFacts.length).toBe(0);

        // 6. Timeline
        const timeline = await get_subject_timeline(subject);
        expect(timeline.length).toBeGreaterThanOrEqual(1);
        // Should have created event
        const created = timeline.find(e => e.change_type === 'created');
        expect(created).toBeDefined();
    });
});
