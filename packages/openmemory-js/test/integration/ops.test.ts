import { describe, expect, test, mock, beforeEach } from "bun:test";
import { ingestDocument, ingestUrl } from "../../src/ops/ingest";
import { extractText, extractAudio } from "../../src/ops/extract";
import { compressionEngine } from "../../src/ops/compress";
import { q, transaction } from "../../src/core/db";

// Mock DB
const mockTransactionRun = mock(async (cb: any) => cb());
mock.module("../../src/core/db", () => ({
    q: {
        insMem: { run: mock(async () => { }) },
        insWaypoint: { run: mock(async () => { }) },
        insLog: { run: mock(async () => { }) },
        updLog: { run: mock(async () => { }) },
        insMems: { run: mock(async () => { }) },
        insWaypoints: { run: mock(async () => { }) },
    },
    transaction: {
        run: mockTransactionRun,
    },
    addHsgMemory: mock(async () => ({ id: "mock-memory-id" })),
}));

// Mock HSG
mock.module("../../src/memory/hsg", () => ({
    addHsgMemory: mock(async () => ({ id: "mock-memory-id" })),
}));

// Mock OpenAI
mock.module("openai", () => {
    return {
        default: class OpenAI {
            audio = {
                transcriptions: {
                    create: mock(async () => ({
                        text: "Transcribed audio text",
                        duration: 10.5,
                        language: "en"
                    }))
                }
            }
        }
    };
});

describe("Ops: Extraction", () => {
    test("extractText processes plain text correctly", async () => {
        const text = "Hello World";
        const result = await extractText("txt", Buffer.from(text));
        expect(result.text).toBe(text);
        expect(result.metadata.contentType).toBe("txt");
    });

    test("extractText handles CSV/Markdown as passthrough", async () => {
        const md = "# Heading\nContent";
        const result = await extractText("markdown", Buffer.from(md));
        expect(result.text).toBe(md);
        expect(result.metadata.contentType).toBe("markdown");
    });
});

describe("Ops: Ingestion", () => {
    beforeEach(() => {
        mockTransactionRun.mockClear();
    });

    test("ingestDocument single strategy for small docs", async () => {
        const result = await ingestDocument("txt", "Small doc");
        expect(result.strategy).toBe("single");
        expect(result.childCount).toBe(0);
        expect(result.rootMemoryId).toBeTruthy();
    });

    test("ingestDocument root-child strategy for large docs (forced)", async () => {
        // Force root strategy via config
        const largeText = "A".repeat(100);
        const result = await ingestDocument("txt", largeText, { config: { forceRoot: true, secSz: 50 } });

        expect(result.strategy).toBe("root-child");
        expect(result.childCount).toBeGreaterThan(0);
        // Should have called transaction logic
        expect(mockTransactionRun).toHaveBeenCalled();
    });
});

describe("Ops: Compression", () => {
    test("Semantic compression removes stop words", () => {
        const input = "This is a very simple test that should be compressed.";
        const result = compressionEngine.compress(input, "semantic");
        expect(result.metrics.saved).toBeGreaterThan(0);
        expect(result.comp.length).toBeLessThan(input.length);
    });

    test("Aggressive compression handles code keywords", () => {
        const input = "function example() { return variable; }";
        const result = compressionEngine.compress(input, "aggressive");
        // "function" -> "fn", "return" -> "ret", "variable" -> "var"
        expect(result.comp).toContain("fn");
        expect(result.comp).toContain("ret");
    });
});
