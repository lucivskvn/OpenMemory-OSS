/**
 * Text Chunking Utilities for OpenMemory.
 * Provides strategies for splitting large documents while preserving semantic boundaries (paragraphs, sentences).
 */
const DEFAULT_CPT = 4;
const estimateTokens = (t: string) => Math.ceil(t.length / DEFAULT_CPT);

export interface TextChunk {
    text: string;
    start: number;
    end: number;
    tokens: number;
}

/**
 * Splits text into sections based on size and overlap, respecting constraints.
 * Prioritizes breaking at double newlines, then newlines, then spaces.
 */
export const splitText = (
    text: string,
    size: number,
    overlap: number = 0,
): string[] => {
    if (size <= 0) throw new Error("Chunk size must be positive");
    if (overlap < 0) throw new Error("Overlap must be non-negative");
    if (overlap >= size) overlap = size - 1; // Enforce distinct progress

    if (text.length <= size) return [text];

    const sections: string[] = [];
    let startIndex = 0;

    while (startIndex < text.length) {
        let endIndex = startIndex + size;

        // If not at end, try to break at a newline or space
        if (endIndex < text.length) {
            const lookback = Math.min(size - Math.max(overlap, 50), 500);
            const slice = text.slice(endIndex - lookback, endIndex);

            // Priority: Double newline, then Single newline, then Space
            const lastDoubleNewline = slice.lastIndexOf("\n\n");
            const lastNewline = slice.lastIndexOf("\n");
            const lastSpace = slice.lastIndexOf(" ");

            if (lastDoubleNewline !== -1) {
                endIndex = endIndex - lookback + lastDoubleNewline + 2;
            } else if (lastNewline !== -1) {
                endIndex = endIndex - lookback + lastNewline + 1;
            } else if (lastSpace !== -1) {
                endIndex = endIndex - lookback + lastSpace + 1;
            }
        }

        const chunk = text.slice(startIndex, endIndex).trim();
        if (chunk) sections.push(chunk);

        if (endIndex >= text.length) break;
        startIndex = Math.max(startIndex + 1, endIndex - overlap);
    }

    return sections;
};

/**
 * Legacy/Variant: Splits text into sections based on paragraph boundaries.
 */
export const chunkTextByParagraphs = (
    txt: string,
    tgt = 768,
    ovr = 0.1,
): TextChunk[] => {
    const tot = estimateTokens(txt);
    if (tot <= tgt)
        return [{ text: txt, start: 0, end: txt.length, tokens: tot }];

    const tch = tgt * DEFAULT_CPT,
        och = Math.floor(tch * ovr);
    const paras = txt.split(/\n\n+/);

    const chks: TextChunk[] = [];
    let cur = "",
        cs = 0;

    for (const p of paras) {
        const sents = p.split(/(?<=[.!?])\s+/);
        for (const s of sents) {
            const pot = cur + (cur ? " " : "") + s;
            if (pot.length > tch && cur.length > 0) {
                chks.push({
                    text: cur,
                    start: cs,
                    end: cs + cur.length,
                    tokens: estimateTokens(cur),
                });
                const ovt = cur.slice(-och);
                cur = ovt + " " + s;
                cs = cs + cur.length - ovt.length - 1;
            } else cur = pot;
        }
    }

    if (cur.length > 0)
        chks.push({
            text: cur,
            start: cs,
            end: cs + cur.length,
            tokens: estimateTokens(cur),
        });
    return chks;
};

// aggregateVectors moved to src/utils/vectors.ts

export const joinChunks = (cks: TextChunk[]) =>
    cks.length ? cks.map((c) => c.text).join(" ") : "";
