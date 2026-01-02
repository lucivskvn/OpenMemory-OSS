import { describe, test, expect, beforeAll } from "bun:test";
import { Memory } from "../src/core/memory";
// We don't want to actually connect to DB/Redis if not needed, but Memory class might init things.
// The compression engine is in-memory mostly, so that's safe.

describe("SDK Parity", () => {
    let mem: Memory;

    beforeAll(() => {
        mem = new Memory("test_user");
    });

    test("Compression Facade exists", () => {
        expect(mem.compression).toBeDefined();
        expect(typeof mem.compression.compress).toBe("function");
        expect(typeof mem.compression.batch).toBe("function");
        expect(typeof mem.compression.analyze).toBe("function");
        expect(typeof mem.compression.stats).toBe("function");
        expect(typeof mem.compression.reset).toBe("function");
    });

    test("Compression Facade works", () => {
        const text = "This is a very redundant sentence that is redundant.";
        const res = mem.compression.compress(text, "semantic");
        expect(res).toBeDefined();
        expect(res.comp.length).toBeLessThanOrEqual(text.length);
        expect(res.metrics.algorithm).toBe("semantic");
    });

    test("Temporal Facade exists", () => {
        expect(mem.temporal).toBeDefined();
        expect(typeof mem.temporal.add).toBe("function");
        expect(typeof mem.temporal.get).toBe("function");
        expect(typeof mem.temporal.search).toBe("function");
        expect(typeof mem.temporal.history).toBe("function");
    });

    test("Source Facade exists", () => {
        expect(typeof mem.source).toBe("function");
        // We can't easily test calling it without mocking imports or having env vars, 
        // as it does dynamic import.
    });
});
