import { describe, expect, test } from "bun:test";
import { column_satisfied, migration_is_pending } from "../src/core/migrate";

describe("migration recovery", () => {
    test("applies migrations newer than the recorded version", () => {
        expect(migration_is_pending("1.3.0", "1.2.0", true)).toBe(true);
    });

    test("reapplies a migration when its completion column is missing", () => {
        expect(migration_is_pending("1.3.0", "1.4.3", false)).toBe(true);
    });

    test("skips migrations that are current and complete", () => {
        expect(migration_is_pending("1.3.0", "1.4.3", true)).toBe(false);
    });

    test("treats completion columns on absent tables as satisfied", async () => {
        expect(
            await column_satisfied(
                "definitely_missing_table_xyz",
                "project_id",
            ),
        ).toBe(true);
    });

    test("requires completion columns on existing tables", async () => {
        expect(await column_satisfied("memories", "definitely_missing_col")).toBe(
            false,
        );
    });
});
