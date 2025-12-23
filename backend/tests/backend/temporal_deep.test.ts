import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
    create_fact,
    get_facts,
    create_edge,
    get_related_facts,
    get_subject_timeline,
    search_facts,
    get_change_frequency,
    compare_time_points,
    get_volatile_facts,
    invalidate_fact
} from "../../src/memory/temporal";
import { init_db } from "../../src/core/db";
import { unlink } from "node:fs/promises";

const DB_PATH = "./test_temporal_deep.sqlite";

describe("Temporal Graph Deep Dive Logic", () => {
    beforeAll(async () => {
        process.env.OM_DB_PATH = DB_PATH;
        await init_db();
    });

    afterAll(async () => {
        try {
            await unlink(DB_PATH);
            await unlink(`${DB_PATH}-shm`);
            await unlink(`${DB_PATH}-wal`);
        } catch (e) {
            // ignore
        }
    });

    test("Timeline Analysis", async () => {
        const sub = "ProjectX";
        await create_fact(sub, "status", "draft", Date.now() - 10000);
        await create_fact(sub, "status", "review", Date.now() - 5000);
        await create_fact(sub, "status", "live", Date.now());

        const timeline = await get_subject_timeline(sub);
        expect(timeline.length).toBeGreaterThanOrEqual(3);
        expect(timeline[0].object).toBe("draft");
        expect(timeline[timeline.length - 1].object).toBe("live");
    });

    test("Graph Traversal", async () => {
        const f1 = await create_fact("A", "knows", "B");
        const f2 = await create_fact("B", "knows", "C");
        await create_edge(f1, f2, "implies");

        const related = await get_related_facts(f1);
        expect(related.length).toBe(1);
        expect(related[0].fact.id).toBe(f2);
        expect(related[0].relation).toBe("implies");
    });

    test("Search", async () => {
        await create_fact("HiddenGem", "is", "found");
        const res = await search_facts("Hidden");
        expect(res.length).toBeGreaterThan(0);
        expect(res[0].subject).toBe("HiddenGem");
    });

    test("Frequency Analysis", async () => {
        const sub = "Volatile";
        await create_fact(sub, "state", "1");
        await create_fact(sub, "state", "2");
        await create_fact(sub, "state", "3");

        const freq = await get_change_frequency(sub, "state");
        expect(freq.total_changes).toBeGreaterThanOrEqual(3);
    });

    test("Compare Time Points", async () => {
        const sub = "TimeTraveler";
        const t1 = Date.now() - 5000;
        await create_fact(sub, "loc", "past", t1);

        const t2 = Date.now();
        await create_fact(sub, "loc", "present", t2); // This closes "past"

        const diff = await compare_time_points(sub, t1, t2);
        // At t1: loc=past. At t2: loc=present.
        // So changed: past -> present
        expect(diff.changed.length).toBe(1);
        expect(diff.changed[0].before.object).toBe("past");
        expect(diff.changed[0].after.object).toBe("present");
    });
});
