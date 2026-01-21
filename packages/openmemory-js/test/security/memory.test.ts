import { describe, test, expect, afterAll } from "bun:test";
import { q, closeDb } from "../../src/core/db";

describe("Core Memory Security Tests", () => {
    afterAll(async () => {
        await closeDb();
    });

    test("getMems Safety Limit", async () => {
        const ids = Array.from({ length: 5001 }, (_, i) => `id_${i}`);
        // Expect checking 5001 IDs to fail
        try {
            await q.getMems.all(ids);
            throw new Error("Should have thrown");
        } catch (e: any) {
            expect(e.message).toContain("too many IDs requested");
        }
    });

    test("getMems Safe Chunk", async () => {
        const ids = Array.from({ length: 100 }, (_, i) => `id_${i}`);
        // Should not throw
        await q.getMems.all(ids);
    });
});
