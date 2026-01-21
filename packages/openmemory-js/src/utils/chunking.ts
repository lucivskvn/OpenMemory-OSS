/**
 * Text Chunking Utilities for OpenMemory.
 * Provides strategies for splitting large documents while preserving semantic boundaries (paragraphs, sentences).
 */
const DEFAULT_CHAR_PER_TOKEN = 4;
/**
 * Estimates the number of tokens in a given text.
 * @param text The text to estimate tokens for.
 * @returns Estimated token count.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / DEFAULT_CHAR_PER_TOKEN);

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

        // Validating Surrogate Pairs: Don't split exactly between a high/low surrogate
        // Only check if we are actually cutting the string (not at the end)
        if (endIndex < text.length) {
            const charCode = text.charCodeAt(endIndex);
            if (charCode >= 0xDC00 && charCode <= 0xDFFF) {
                // Check if previous is high surrogate (0xD800-0xDBFF)
                const prevCode = text.charCodeAt(endIndex - 1);
                if (prevCode >= 0xD800 && prevCode <= 0xDBFF) {
                    endIndex--;
                }
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
    text: string,
    targetTokens = 768,
    overlapRatio = 0.1,
): TextChunk[] => {
    const totalTokens = estimateTokens(text);
    if (totalTokens <= targetTokens)
        return [{ text: text, start: 0, end: text.length, tokens: totalTokens }];

    const targetCharLimit = targetTokens * DEFAULT_CHAR_PER_TOKEN;
    const overlapCharLimit = Math.floor(targetCharLimit * overlapRatio);
    const paragraphs = text.split(/\n\n+/);

    const chunks: TextChunk[] = [];
    let currentText = "";
    let currentIndex = 0;

    for (const paragraph of paragraphs) {
        // Split by sentences using lookbehind for terminal punctuation
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
            const potentialChunk = currentText + (currentText ? " " : "") + sentence;

            if (potentialChunk.length > targetCharLimit && currentText.length > 0) {
                chunks.push({
                    text: currentText,
                    start: currentIndex,
                    end: currentIndex + currentText.length,
                    tokens: estimateTokens(currentText),
                });

                // Carry over overlap for continuity
                // Safe slice to avoid splitting surrogate pairs
                let sliceStart = currentText.length - overlapCharLimit;
                // If sliceStart lands on low surrogate (DC00-DFFF) of a pair...
                // Actually slice(-N) counts from end. 
                // Let's use code point aware slicing if needed but for now just check boundary.
                const charAtCut = currentText.charCodeAt(sliceStart);
                const charBeforeCut = currentText.charCodeAt(sliceStart - 1);

                // If we are cutting between High (prev) and Low (curr) surrogate
                if (charAtCut >= 0xDC00 && charAtCut <= 0xDFFF && charBeforeCut >= 0xD800 && charBeforeCut <= 0xDBFF) {
                    sliceStart--; // Include the high surrogate in the overlap (move back)
                }

                const overlapText = currentText.slice(sliceStart);
                currentText = overlapText + (overlapText ? " " : "") + sentence;
                currentIndex = currentIndex + currentText.length - overlapText.length - 1;
            } else {
                currentText = potentialChunk;
            }
        }
    }

    if (currentText.length > 0) {
        chunks.push({
            text: currentText,
            start: currentIndex,
            end: currentIndex + currentText.length,
            tokens: estimateTokens(currentText),
        });
    }

    return chunks;
};

// aggregateVectors moved to src/utils/vectors.ts

export const joinChunks = (cks: TextChunk[]) =>
    cks.length ? cks.map((c) => c.text).join(" ") : "";
