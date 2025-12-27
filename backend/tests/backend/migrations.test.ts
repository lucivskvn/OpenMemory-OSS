import { describe, expect, it } from "bun:test";
import { migrations } from "../../src/core/schema";

import { compareSemver } from "../../src/core/migrations";

describe("Schema migrations", () => {
    it("includes v1.7.0 and v1.8.0 in migrations", () => {
        const has17 = migrations.some(m => m.version === "1.7.0");
        const has18 = migrations.some(m => m.version === "1.8.0");
        expect(has17).toBe(true);
        expect(has18).toBe(true);
    });

    it("compareSemver behaves as expected", () => {
        expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
        expect(compareSemver("1.2.1", "1.2.0")).toBe(1);
        expect(compareSemver("1.10.0", "1.2.0")).toBe(1);
        expect(compareSemver("1.0.0", "1.2.0")).toBe(-1);
        expect(compareSemver(null, "1.0.0")).toBe(-1);
        expect(compareSemver("1.0.0", null)).toBe(1);
    });

    it("migrations array should be ordered ascending by version", () => {
        for (let i = 1; i < migrations.length; i++) {
            expect(compareSemver(migrations[i].version, migrations[i-1].version)).toBeGreaterThan(0);
        }
    });
});