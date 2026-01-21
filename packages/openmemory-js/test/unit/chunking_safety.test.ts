
import { describe, expect, it } from "bun:test";
import { splitText } from "../../src/utils/chunking";

describe("Chunking Safety (Surrogate Pairs)", () => {
    it("should not split a surrogate pair given a hard limit", () => {
        // "😀" is \uD83D\uDE00. Length 2.
        const text = "A😀B"; 
        // Index 0: 'A'
        // Index 1: \uD83D (High)
        // Index 2: \uDE00 (Low)
        // Index 3: 'B'
        
        // Try splitting with size 2. 
        // Naive split: "A" + High Surrogate.
        // Expected: "A", then "😀B" (or similar overlap).
        
        const chunks = splitText(text, 2, 0);
        // Expect chunk 1 to be "A" (length 1), because taking 2 would split the emoji.
        // Wait, if start=0, end=2. Slice(0,2) = "A" + \uD83D. 
        // My fix backtracks end if checks pass.
        // So end becomes 1. Slice(0,1) = "A".
        
        expect(chunks[0]).toBe("A");
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[1]).toContain("😀");
    });

    it("should handle multiple surrogate pairs correctly", () => {
        const text = "👍👍👍";
        // 3 emojis. Length 6.
        // Split size 3.
        // Chunk 1: indices 0-3. '👍' (2) + half '👍' (1).
        // Should backtrack to 2. '👍'.
        const chunks = splitText(text, 3, 0);
        expect(chunks[0]).toBe("👍");
        expect(chunks[1]).toBe("👍");
        expect(chunks[2]).toBe("👍");
    });
});
