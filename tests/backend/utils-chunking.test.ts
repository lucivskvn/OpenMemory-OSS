import { describe, test, expect } from "bun:test";
import { chunk_text, agg_vec, join_chunks } from "../../backend/src/utils/chunking";

/**
 * Chunking Utility Tests
 * 
 * Tests text chunking with various sizes, overlap, aggregation, and edge cases
 * for backend/src/utils/chunking.ts
 */

describe("Text Chunking (chunking.ts)", () => {
    describe("chunk_text - Basic Functionality", () => {
        test("returns single chunk for short text under target", () => {
            const text = "This is a short text.";
            const chunks = chunk_text(text, 768, 0.1);

            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toBe(text);
            expect(chunks[0].start).toBe(0);
            expect(chunks[0].end).toBe(text.length);
            expect(chunks[0].tokens).toBeGreaterThan(0);
        });

        test("splits long text into multiple chunks when sentences present", () => {
            // chunk_text splits on sentence boundaries; ensure the input contains
            // sentence terminators so splitting can occur deterministically.
            const longText = ("Sentence one. Sentence two. Sentence three. ").repeat(400);
            const chunks = chunk_text(longText, 768, 0.1);

            expect(chunks.length).toBeGreaterThan(1);
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeGreaterThan(0);
                expect(chunk.tokens).toBeGreaterThan(0);
            }
        });

        test("chunks have correct start/end positions when sentences present", () => {
            const text = ("This is a sentence. ").repeat(300);
            const chunks = chunk_text(text, 200, 0.1);

            expect(chunks.length).toBeGreaterThan(1);

            // First chunk starts at 0
            expect(chunks[0].start).toBe(0);

            // Each chunk's end should be consistent with text length
            for (const chunk of chunks) {
                expect(chunk.end - chunk.start).toBeLessThanOrEqual(chunk.text.length + 10);
            }
        });

        test("respects target token count for sentence-delimited text", () => {
            const sentence = "A short sentence. ";
            const text = sentence.repeat(1000);
            const target = 400;
            const chunks = chunk_text(text, target, 0.1);

            // Characters per token = 4, so target*4 = max chars
            const maxChars = target * 4;
            for (const chunk of chunks) {
                // Allow some flexibility for sentence/paragraph boundaries
                expect(chunk.text.length).toBeLessThanOrEqual(maxChars * 1.2);
            }
        });

        test("applies overlap between chunks", () => {
            const text = "The quick brown fox jumps. ".repeat(200);
            const chunks = chunk_text(text, 300, 0.2); // 20% overlap

            if (chunks.length > 1) {
                // Check that some content overlaps between consecutive chunks
                for (let i = 0; i < chunks.length - 1; i++) {
                    const currentEnd = chunks[i].text.slice(-50);
                    const nextStart = chunks[i + 1].text.slice(0, 100);

                    // Should have some overlapping words
                    const currentWords = currentEnd.split(/\s+/);
                    const nextWords = nextStart.split(/\s+/);
                    const overlap = currentWords.filter(w => nextWords.includes(w));

                    expect(overlap.length).toBeGreaterThan(0);
                }
            }
        });
    });

    describe("chunk_text - Paragraph Awareness", () => {
        test("respects paragraph boundaries", () => {
            const para1 = "First paragraph with some content. ".repeat(50);
            const para2 = "Second paragraph with different content. ".repeat(50);
            const text = para1 + "\n\n" + para2;

            const chunks = chunk_text(text, 500, 0.1);

            // Chunks should not break mid-word
            for (const chunk of chunks) {
                expect(chunk.text.startsWith(" ")).toBe(false);
            }
        });

        test("handles multiple consecutive newlines", () => {
            const text = "Paragraph one.\n\n\n\nParagraph two.\n\n\nParagraph three.";
            const chunks = chunk_text(text, 50, 0.1);

            expect(chunks.length).toBeGreaterThan(0);
            // Should handle multiple newlines gracefully
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeGreaterThan(0);
            }
        });
    });

    describe("chunk_text - Sentence Awareness", () => {
        test("respects sentence boundaries when possible", () => {
            const sentences = [
                "This is sentence one.",
                "This is sentence two!",
                "This is sentence three?",
                "This is sentence four."
            ];
            const text = sentences.join(" ").repeat(100);

            const chunks = chunk_text(text, 200, 0.1);

            // Most chunks should end near sentence boundaries
            for (const chunk of chunks) {
                const lastChar = chunk.text.trim().slice(-1);
                // Many chunks should end with sentence terminators
                // (Not all, due to target size constraints)
                expect(['.', '!', '?', ' ']).toContain(lastChar);
            }
        });

        test("handles mixed sentence terminators", () => {
            const text = "Question? Answer. Exclamation! Normal sentence. ".repeat(100);
            const chunks = chunk_text(text, 300, 0.1);

            expect(chunks.length).toBeGreaterThan(0);
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeGreaterThan(0);
            }
        });
    });

    describe("chunk_text - Edge Cases", () => {
        test("handles empty string", () => {
            const chunks = chunk_text("", 768, 0.1);

            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toBe("");
            expect(chunks[0].start).toBe(0);
            expect(chunks[0].end).toBe(0);
        });

        test("handles single word", () => {
            const chunks = chunk_text("word", 768, 0.1);

            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toBe("word");
        });

        test("handles text with no spaces", () => {
            const text = "verylongwordwithnospacesatall".repeat(100);
            const chunks = chunk_text(text, 300, 0.1);

            expect(chunks.length).toBeGreaterThan(0);
            // Should still split even without sentence boundaries
        });

        test("handles zero overlap with sentence inputs", () => {
            const text = ("Zero overlap sentence. ").repeat(400);
            const chunks = chunk_text(text, 300, 0.0);

            expect(chunks.length).toBeGreaterThan(1);
            // With 0 overlap, chunks should be more distinct
        });

        test("handles high overlap", () => {
            const text = "sentence ".repeat(500);
            const chunks = chunk_text(text, 300, 0.5); // 50% overlap

            if (chunks.length > 1) {
                // High overlap means more chunks
                expect(chunks.length).toBeGreaterThan(2);
            }
        });

        test("handles small target size for sentence inputs", () => {
            const text = ("Small sentence. ").repeat(200);
            const chunks = chunk_text(text, 10, 0.1);

            // Should create many small chunks
            expect(chunks.length).toBeGreaterThan(5);
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeGreaterThan(0);
            }
        });

        test("handles very large target size", () => {
            const text = "word ".repeat(100);
            const chunks = chunk_text(text, 10000, 0.1);

            // Should fit in single chunk
            expect(chunks).toHaveLength(1);
            expect(chunks[0].text).toBe(text);
        });
    });

    describe("chunk_text - Token Estimation", () => {
        test("token count is reasonable for chunk size", () => {
            const text = "word ".repeat(1000);
            const chunks = chunk_text(text, 500, 0.1);

            for (const chunk of chunks) {
                // 4 chars per token estimate
                const expectedTokens = Math.ceil(chunk.text.length / 4);
                expect(chunk.tokens).toBeCloseTo(expectedTokens, 2);
            }
        });

        test("token count increases with text length", () => {
            const shortText = "short";
            const longText = "longer text with more content";

            const shortChunks = chunk_text(shortText, 768);
            const longChunks = chunk_text(longText, 768);

            expect(longChunks[0].tokens).toBeGreaterThan(shortChunks[0].tokens);
        });
    });

    describe("agg_vec - Vector Aggregation", () => {
        test("averages single vector returns copy", () => {
            const vec = [1.0, 2.0, 3.0, 4.0];
            const result = agg_vec([vec]);

            expect(result).toEqual(vec);
            expect(result).not.toBe(vec); // Should be a copy
        });

        test("averages two vectors correctly", () => {
            const vec1 = [2.0, 4.0, 6.0];
            const vec2 = [4.0, 6.0, 8.0];
            const result = agg_vec([vec1, vec2]);

            expect(result).toEqual([3.0, 5.0, 7.0]);
        });

        test("averages multiple vectors correctly", () => {
            const vecs = [
                [1.0, 2.0, 3.0],
                [2.0, 3.0, 4.0],
                [3.0, 4.0, 5.0]
            ];
            const result = agg_vec(vecs);

            expect(result).toEqual([2.0, 3.0, 4.0]);
        });

        test("handles zero vectors", () => {
            const vecs = [
                [0.0, 0.0, 0.0],
                [0.0, 0.0, 0.0]
            ];
            const result = agg_vec(vecs);

            expect(result).toEqual([0.0, 0.0, 0.0]);
        });

        test("handles negative values", () => {
            const vecs = [
                [-1.0, -2.0, -3.0],
                [1.0, 2.0, 3.0]
            ];
            const result = agg_vec(vecs);

            expect(result).toEqual([0.0, 0.0, 0.0]);
        });

        test("throws error for empty array", () => {
            expect(() => agg_vec([])).toThrow("no vecs");
        });

        test("handles large dimensions", () => {
            const dim = 1536;
            const vec1 = new Array(dim).fill(1.0);
            const vec2 = new Array(dim).fill(2.0);
            const result = agg_vec([vec1, vec2]);

            expect(result.length).toBe(dim);
            expect(result[0]).toBe(1.5);
            expect(result[dim - 1]).toBe(1.5);
        });

        test("preserves precision for floating point", () => {
            const vecs = [
                [0.123456789, 0.987654321],
                [0.234567890, 0.876543210]
            ];
            const result = agg_vec(vecs);

            expect(result[0]).toBeCloseTo(0.1790123395, 8);
            expect(result[1]).toBeCloseTo(0.9320987655, 8);
        });
    });

    describe("join_chunks - Chunk Joining", () => {
        test("joins multiple chunks with spaces", () => {
            const chunks = [
                { text: "First chunk", start: 0, end: 11, tokens: 3 },
                { text: "Second chunk", start: 12, end: 24, tokens: 3 },
                { text: "Third chunk", start: 25, end: 36, tokens: 3 }
            ];
            const result = join_chunks(chunks);

            expect(result).toBe("First chunk Second chunk Third chunk");
        });

        test("handles empty array", () => {
            const result = join_chunks([]);

            expect(result).toBe("");
        });

        test("handles single chunk", () => {
            const chunks = [
                { text: "Only chunk", start: 0, end: 10, tokens: 2 }
            ];
            const result = join_chunks(chunks);

            expect(result).toBe("Only chunk");
        });

        test("preserves chunk text exactly", () => {
            const chunks = [
                { text: "Chunk with punctuation!", start: 0, end: 23, tokens: 4 },
                { text: "Chunk with (parentheses)", start: 24, end: 48, tokens: 4 }
            ];
            const result = join_chunks(chunks);

            expect(result).toContain("punctuation!");
            expect(result).toContain("(parentheses)");
        });

        test("handles chunks with existing spaces", () => {
            const chunks = [
                { text: "  Chunk with spaces  ", start: 0, end: 21, tokens: 4 },
                { text: " Another chunk ", start: 22, end: 37, tokens: 3 }
            ];
            const result = join_chunks(chunks);

            // Should join with single space between
            expect(result).toContain("Chunk with spaces");
            expect(result).toContain("Another chunk");
        });
    });

    describe("Integration - Full Workflow", () => {
        test("chunk, aggregate vectors, and rejoin text", () => {
            const originalText = "This is a test document. It has multiple sentences. " +
                "We will chunk it, process vectors, and rejoin. " +
                "This tests the full chunking workflow.";

            const chunks = chunk_text(originalText, 50, 0.1);

            // Simulate vector processing
            const mockVectors = chunks.map(() => [0.1, 0.2, 0.3]);
            const aggregated = agg_vec(mockVectors);

            // Rejoin text
            const rejoined = join_chunks(chunks);

            expect(aggregated).toEqual([0.1, 0.2, 0.3]);
            expect(rejoined).toContain("test document");
            expect(rejoined).toContain("multiple sentences");
        });

        test("handles real-world document structure", () => {
            const document = `
# Document Title

This is the introduction paragraph with some context.

## Section 1

First section content with multiple sentences. This continues the thought.

## Section 2

Second section with more content. It includes various details and information.

## Conclusion

Final thoughts and summary of the document.
            `.trim();

            const chunks = chunk_text(document, 200, 0.15);

            expect(chunks.length).toBeGreaterThan(0);

            // Verify all chunks are non-empty
            for (const chunk of chunks) {
                expect(chunk.text.trim().length).toBeGreaterThan(0);
            }

            // Rejoined should preserve key sections
            const rejoined = join_chunks(chunks);
            expect(rejoined).toContain("Document Title");
            expect(rejoined).toContain("Section 1");
            expect(rejoined).toContain("Conclusion");
        });
    });
});
