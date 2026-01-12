import { env } from "../core/cfg";
import { canonicalTokensFromText } from "./text";

export interface KeywordMatch {
    id: string;
    score: number;
    matchedTerms: string[];
}

export function extractKeywords(
    text: string,
    minLength: number = env.keywordMinLength,
): Set<string> {
    const tokens = canonicalTokensFromText(text);
    const keywords = new Set<string>();

    for (const token of tokens) {
        if (token.length >= minLength) {
            keywords.add(token);
        }
    }

    // Word-level N-Grams
    if (tokens.length > 1) {
        for (let i = 0; i < tokens.length - 1; i++) {
            const bigram = `${tokens[i]}_${tokens[i + 1]}`;
            if (bigram.length >= minLength) {
                keywords.add(bigram);
            }
        }
    }

    if (tokens.length > 2) {
        for (let i = 0; i < tokens.length - 2; i++) {
            const trigram = `${tokens[i]}_${tokens[i + 1]}_${tokens[i + 2]}`;
            if (trigram.length >= minLength) {
                keywords.add(trigram);
            }
        }
    }

    return keywords;
}

export function computeKeywordOverlap(
    queryKeywords: Set<string>,
    contentKeywords: Set<string>,
): number {
    let matches = 0;
    let totalWeight = 0;

    for (const qk of queryKeywords) {
        if (contentKeywords.has(qk)) {
            const weight = qk.includes("_") ? 2.0 : 1.0;
            matches += weight;
        }
        totalWeight += qk.includes("_") ? 2.0 : 1.0;
    }

    if (totalWeight === 0) return 0;
    return matches / totalWeight;
}

export function exactPhraseMatch(query: string, content: string): boolean {
    const qNorm = query.toLowerCase().trim();
    const cNorm = content.toLowerCase();
    return cNorm.includes(qNorm);
}

export function computeBm25Score(
    queryTerms: string[],
    contentTerms: string[],
    corpusSize: number = 10000,
    avgDocLength: number = 100,
): number {
    const k1 = 1.5;
    const b = 0.75;

    const termFreq = new Map<string, number>();
    for (const term of contentTerms) {
        termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }

    const docLength = contentTerms.length;
    let score = 0;

    for (const qTerm of queryTerms) {
        const tf = termFreq.get(qTerm) || 0;
        if (tf === 0) continue;

        const idf = Math.log((corpusSize + 1) / (tf + 0.5));
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));

        score += idf * (numerator / denominator);
    }

    return score;
}

export async function keywordFilterMemories(
    query: string,
    allMemories: Array<{ id: string; content: string }>,
    threshold: number = 0.1,
): Promise<Map<string, number>> {
    const queryKeywords = extractKeywords(query, env.keywordMinLength);
    const queryTerms = canonicalTokensFromText(query);
    const scores = new Map<string, number>();

    for (const mem of allMemories) {
        let totalScore = 0;

        if (exactPhraseMatch(query, mem.content)) {
            totalScore += 1.0;
        }

        const contentKeywords = extractKeywords(
            mem.content,
            env.keywordMinLength,
        );
        const keywordScore = computeKeywordOverlap(
            queryKeywords,
            contentKeywords,
        );
        totalScore += keywordScore * 0.8;

        const contentTerms = canonicalTokensFromText(mem.content);
        const bm25Score = computeBm25Score(queryTerms, contentTerms);
        totalScore += Math.min(1.0, bm25Score / 10) * 0.5;

        if (totalScore > threshold) {
            scores.set(mem.id, totalScore);
        }
    }

    return scores;
}
