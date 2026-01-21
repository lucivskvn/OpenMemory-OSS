import { env } from "../core/cfg";
import type {
    CompressionMetrics,
    CompressionResult,
    CompressionStats,
} from "../core/types";
import { normalizeUserId } from "../utils";
import { SimpleCache } from "../utils/cache";

export { CompressionMetrics, CompressionResult, CompressionStats };

const FILLER_WORDS = [
    /(?:,\s*)?\b(just|really|very|quite|rather|somewhat|somehow)\b/gi,
    /(?:,\s*)?\b(actually|basically|essentially|literally)\b/gi,
    /(?:,\s*)?\b(I think that|I believe that|It seems that|It appears that)\b/gi,
    /(?:,\s*)?\b(in order to)\b/gi,
];

const SEMANTIC_REPLACEMENTS: [RegExp, string][] = [
    [/\bat this point in time\b/gi, "now"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bin the event that\b/gi, "if"],
    [/\bfor the purpose of\b/gi, "to"],
    [/\bin the near future\b/gi, "soon"],
    [/\ba number of\b/gi, "several"],
    [/\bprior to\b/gi, "before"],
    [/\bsubsequent to\b/gi, "after"],
];

const SYNTACTIC_CONTRACTIONS: [RegExp, string][] = [
    [/\bdo not\b/gi, "don't"],
    [/\bcannot\b/gi, "can't"],
    [/\bwill not\b/gi, "won't"],
    [/\bshould not\b/gi, "shouldn't"],
    [/\bwould not\b/gi, "wouldn't"],
    [/\bit is\b/gi, "it's"],
    [/\bthat is\b/gi, "that's"],
    [/\bwhat is\b/gi, "what's"],
    [/\bwho is\b/gi, "who's"],
    [/\bthere is\b/gi, "there's"],
    [/\bhas been\b/gi, "been"],
    [/\bhave been\b/gi, "been"],
];

const TECH_ABBREVIATIONS: [RegExp, string][] = [
    [/\bJavaScript\b/gi, "JS"],
    [/\bTypeScript\b/gi, "TS"],
    [/\bPython\b/gi, "Py"],
    [/\bapplication\b/gi, "app"],
    [/\bfunction\b/gi, "fn"],
    [/\bparameter\b/gi, "param"],
    [/\bargument\b/gi, "arg"],
    [/\breturn\b/gi, "ret"],
    [/\bvariable\b/gi, "var"],
    [/\bconstant\b/gi, "const"],
    [/\bdatabase\b/gi, "db"],
    [/\brepository\b/gi, "repo"],
    [/\benvironment\b/gi, "env"],
    [/\bconfiguration\b/gi, "config"],
    [/\bdocumentation\b/gi, "docs"],
];

/**
 * Engine for semantic and syntactic text compression.
 * Used to reduce token usage and storage footprint by removing redundant information
 * without losing the core meaning for LLM processing.
 */
class MemoryCompressionEngine {
    private stats: CompressionStats = {
        total: 0,
        originalTokens: 0,
        compressedTokens: 0,
        saved: 0,
        avgRatio: 0,
        latency: 0,
        algorithms: {},
        updated: Date.now(),
    };

    private cache: SimpleCache<string, CompressionResult>;
    private readonly MS_PER_SAVED_TOKEN = 0.05;

    constructor() {
        const size = env?.cacheSegments ? env.cacheSegments * 100 : 500;
        this.cache = new SimpleCache<string, CompressionResult>({
            maxSize: size,
        });
    }

    /**
     * Estimates the number of tokens in a string.
     * Rough approximation: characters/4 + words/2.
     */
    private countTokens(text: string): number {
        if (!text) return 0;
        // Improved heuristic: characters/4.5 + words/0.75 for technical text
        const words = text.split(/\s+/).filter(Boolean).length;
        const chars = text.length;
        return Math.max(1, Math.ceil(chars / 4.2 + words / 1.5));
    }

    /**
     * Semantic compression: removes filler words and simplifies phrases.
     */
    private compressSemantic(text: string): string {
        if (!text || text.length < 50) return text;

        let compressed = text;
        const sentences = text.split(/([.!?]+\s+)/);
        const uniqueSentences: string[] = [];

        for (let i = 0; i < sentences.length; i += 2) {
            const sentence = sentences[i];
            const separator = sentences[i + 1] || "";
            if (
                i === 0 ||
                sentence.toLowerCase().trim() !==
                sentences[i - 2].toLowerCase().trim()
            ) {
                uniqueSentences.push(sentence + separator);
            }
        }

        compressed = uniqueSentences.join("").trim();

        for (const pattern of FILLER_WORDS) {
            compressed = compressed.replace(pattern, "");
        }

        compressed = compressed.replace(/\s+/g, " ").trim();

        for (const [pattern, replacement] of SEMANTIC_REPLACEMENTS) {
            compressed = compressed.replace(pattern, replacement);
        }

        return compressed;
    }

    /**
     * Syntactic compression: applies contractions and removes redundant articles.
     */
    private compressSyntactic(text: string): string {
        if (!text || text.length < 30) return text;

        let compressed = text;

        for (const [pattern, replacement] of SYNTACTIC_CONTRACTIONS) {
            compressed = compressed.replace(pattern, replacement);
        }

        compressed = compressed.replace(
            /\b(the|a|an)\s+(\w+),\s+(the|a|an)\s+/gi,
            "$2, ",
        );
        compressed = compressed
            .replace(/\s*{\s*/g, "{")
            .replace(/\s*}\s*/g, "}");
        compressed = compressed
            .replace(/\s*\(\s*/g, "(")
            .replace(/\s*\)\s*/g, ")");
        compressed = compressed.replace(/\s*;\s*/g, ";");
        return compressed;
    }

    /**
     * Aggressive compression: extremist reduction of technical terms and whitespaces.
     */
    private compressAggressive(text: string): string {
        if (!text) return text;

        let compressed = this.compressSemantic(text);
        compressed = this.compressSyntactic(compressed);

        // Remove markdown formatting
        compressed = compressed.replace(/[*_~`#]/g, "");

        // Shorten URLs to hostnames
        compressed = compressed.replace(
            /https?:\/\/(www\.)?([^/\s]+)(\/[^\s]*)?/gi,
            "$2",
        );

        for (const [pattern, replacement] of TECH_ABBREVIATIONS) {
            compressed = compressed.replace(pattern, replacement);
        }

        // Normalize newlines to single \n for aggressive
        compressed = compressed.replace(/\n+/g, "\n");
        compressed = compressed
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0) // Remove empty lines
            .join("\n");

        return compressed.trim();
    }

    /**
     * Compresses a text string using the specified algorithm.
     * @param text The source text to compress.
     * @param algorithm Compression strategy: 'semantic', 'syntactic', or 'aggressive'.
     * @param userId Optional user context for cache segmentation.
     */
    compress(
        text: string,
        algorithm: "semantic" | "syntactic" | "aggressive" = "semantic",
        userId?: string | null,
    ): CompressionResult {
        if (!text) {
            return {
                og: text,
                comp: text,
                metrics: this.initEmptyMetrics(algorithm),
                hash: this.calculateHash(text),
            };
        }

        const uid = normalizeUserId(userId);
        const h = this.calculateHash(text);
        const cacheKey = `${algorithm}:${uid || "global"}:${h}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const originalTokenCount = this.countTokens(text);
        let compressedText: string;

        switch (algorithm) {
            case "semantic":
                compressedText = this.compressSemantic(text);
                break;
            case "syntactic":
                compressedText = this.compressSyntactic(text);
                break;
            case "aggressive":
                compressedText = this.compressAggressive(text);
                break;
            default:
                compressedText = text;
        }

        const compressedTokenCount = this.countTokens(compressedText);
        const tokensSaved = originalTokenCount - compressedTokenCount;
        const compressionRatio =
            originalTokenCount > 0
                ? compressedTokenCount / originalTokenCount
                : 1;
        const savingsPercentage =
            originalTokenCount > 0
                ? (tokensSaved / originalTokenCount) * 100
                : 0;
        const estimatedLatency = tokensSaved * this.MS_PER_SAVED_TOKEN;

        const metrics: CompressionMetrics = {
            originalTokens: originalTokenCount,
            compressedTokens: compressedTokenCount,
            ratio: compressionRatio,
            saved: tokensSaved,
            pct: savingsPercentage,
            latency: estimatedLatency,
            algorithm: algorithm,
            timestamp: Date.now(),
        };

        const result: CompressionResult = {
            og: text,
            comp: compressedText,
            metrics: metrics,
            hash: h,
        };

        this.updateStats(metrics);
        this.cacheResult(cacheKey, result);
        return result;
    }

    /**
     * Compresses an array of strings in batch.
     */
    batch(
        texts: string[],
        algorithm: "semantic" | "syntactic" | "aggressive" = "semantic",
        userId?: string | null,
    ): CompressionResult[] {
        return texts.map((t) => this.compress(t, algorithm, userId));
    }

    /**
     * Automatically selects and applies the best compression algorithm based on text profile.
     */
    auto(text: string, userId?: string | null): CompressionResult {
        if (!text || text.length < 50)
            return this.compress(text, "semantic", userId);

        const isCode =
            /\b(function|const|let|var|def|class|import|export|fn|func|namespace|include|pub|trait|impl)\b/.test(text) ||
            /[{}:;](?:\s*[\w$]+\s*[:=]\s*|\s*[\w$]+\s*\()/.test(text); // Structural signs of code/JSON
        const hasUrls = /https?:\/\//.test(text);
        const isVerbose = text.split(/\s+/).length > 100;

        let algorithm: "semantic" | "syntactic" | "aggressive";
        if (isCode || hasUrls) {
            algorithm = "aggressive";
        } else if (isVerbose) {
            algorithm = "semantic";
        } else {
            algorithm = "syntactic";
        }

        return this.compress(text, algorithm, userId);
    }

    /**
     * Returns a snapshot of the compression engine metrics.
     */
    getStats(): CompressionStats {
        return { ...this.stats };
    }

    /**
     * Analyzes how different algorithms would compress a given text.
     */
    analyze(
        text: string,
        userId?: string | null,
    ): Record<string, CompressionMetrics> {
        const report: Record<string, CompressionMetrics> = {};
        for (const algorithm of [
            "semantic",
            "syntactic",
            "aggressive",
        ] as const) {
            const result = this.compress(text, algorithm, userId);
            if (result.metrics) {
                report[algorithm] = result.metrics;
            }
        }
        return report;
    }

    /**
     * Resets the compression statistics.
     */
    resetStats(): void {
        this.stats = {
            total: 0,
            originalTokens: 0,
            compressedTokens: 0,
            saved: 0,
            avgRatio: 0,
            latency: 0,
            algorithms: {},
            updated: Date.now(),
        };
    }

    /**
     * Clears the compression cache.
     */
    clearCache(): void {
        this.cache.clear();
    }

    private initEmptyMetrics(algorithm: string): CompressionMetrics {
        return {
            originalTokens: 0,
            compressedTokens: 0,
            ratio: 1,
            saved: 0,
            pct: 0,
            latency: 0,
            algorithm: algorithm,
            timestamp: Date.now(),
        };
    }

    private calculateHash(text: string): string {
        if (typeof Bun !== "undefined" && Bun.hash) {
            return Bun.hash(text).toString();
        }

        // Fallback for non-Bun environments (DJB2 Hash)
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            hash = (hash * 33) ^ text.charCodeAt(i);
        }
        return (hash >>> 0).toString();
    }

    private updateStats(metrics: CompressionMetrics): void {
        this.stats.total++;
        this.stats.originalTokens += metrics.originalTokens;
        this.stats.compressedTokens += metrics.compressedTokens;
        this.stats.saved += metrics.saved;
        this.stats.latency += metrics.latency;
        this.stats.avgRatio =
            this.stats.originalTokens > 0
                ? this.stats.compressedTokens / this.stats.originalTokens
                : 0;
        this.stats.algorithms[metrics.algorithm] =
            (this.stats.algorithms[metrics.algorithm] || 0) + 1;
        this.stats.updated = Date.now();
    }

    private cacheResult(key: string, result: CompressionResult): void {
        this.cache.set(key, result);
    }
}

export const compressionEngine = new MemoryCompressionEngine();
export { MemoryCompressionEngine };
