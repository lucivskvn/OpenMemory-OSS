import { describe, expect, it } from "bun:test";
import { migrations } from "../../src/core/schema";

describe("Schema migrations", () => {
    it("includes v1.7.0 and v1.8.0 in migrations", () => {
        const has17 = migrations.some(m => m.version === "1.7.0");
        const has18 = migrations.some(m => m.version === "1.8.0");
        expect(has17).toBe(true);
        expect(has18).toBe(true);
    });
});