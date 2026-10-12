import { describe, expect, test } from "bun:test";
import { migration_is_pending } from "../src/core/migrate";

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
});
