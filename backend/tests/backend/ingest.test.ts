import { describe, test, expect } from "bun:test";
import { ingestDocument } from "../../src/ops/ingest";
import { init_db } from "../../src/core/db";

// Ensure DB init
await init_db();

describe("Ingest Logic", () => {
    test("Ingest Document (Smoke Test)", async () => {
        const text = "This is a test document.\nIt has multiple lines.\nAnd enough content to theoretically trigger split if threshold was low.";
        const res = await ingestDocument(text, Buffer.from(text), { test: true }, { force_root: true, sec_sz: 50 });

        expect(res).toBeDefined();
        expect(res.strategy).toBe("root-child");
        expect(res.root_memory_id).toBeDefined();
        // Should have split
        expect(res.child_count).toBeGreaterThan(0);
    });
});
