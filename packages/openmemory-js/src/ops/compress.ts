

export interface CompressionMetrics {
    originalTokens: number;
    compressedTokens: number;
    ratio: number;
    saved: number;
    pct: number;
    latency: number;
    algorithm: string;
    timestamp: number;
}

export interface CompressionResult {
    og: string;
    comp: string;
    metrics: CompressionMetrics;
    hash: string;
}

export interface CompressionStats {
    total: number;
    originalTokens: number;
    compressedTokens: number;
    saved: number;
    avgRatio: number;
    latency: number;
    algorithms: Record<string, number>;
    updated: number;
}

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

    private cache = new Map<string, CompressionResult>();
    private readonly MAX = 500;
    private readonly MS = 0.05;

    /**
     * Estimates the number of tokens in a string.
     */
    private countTokens(text: string): number {
        if (!text) return 0;
        const words = text.split(/\s+/).length;
        const chars = text.length;
        return Math.ceil(chars / 4 + words / 2);
    }

    private sem(t: string): string {
        if (!t || t.length < 50) return t;
        let c = t;
        const s = c.split(/[.!?]+\s+/);
        const u = s.filter((x, i, a) => {
            if (i === 0) return true;
            const n = x.toLowerCase().trim();
            const p = a[i - 1].toLowerCase().trim();
            return n !== p;
        });
        c = u.join(". ").trim();
        const f = [
            /\b(just|really|very|quite|rather|somewhat|somehow)\b/gi,
            /\b(actually|basically|essentially|literally)\b/gi,
            /\b(I think that|I believe that|It seems that|It appears that)\b/gi,
            /\b(in order to)\b/gi,
        ];
        for (const p of f) c = c.replace(p, "");
        c = c.replace(/\s+/g, " ").trim();
        const r: [RegExp, string][] = [
            [/\bat this point in time\b/gi, "now"],
            [/\bdue to the fact that\b/gi, "because"],
            [/\bin the event that\b/gi, "if"],
            [/\bfor the purpose of\b/gi, "to"],
            [/\bin the near future\b/gi, "soon"],
            [/\ba number of\b/gi, "several"],
            [/\bprior to\b/gi, "before"],
            [/\bsubsequent to\b/gi, "after"],
        ];
        for (const [p, x] of r) c = c.replace(p, x);
        return c;
    }

    private syn(t: string): string {
        if (!t || t.length < 30) return t;
        let c = t;
        const ct: [RegExp, string][] = [
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
        for (const [p, x] of ct) c = c.replace(p, x);
        c = c.replace(/\b(the|a|an)\s+(\w+),\s+(the|a|an)\s+/gi, "$2, ");
        c = c.replace(/\s*{\s*/g, "{").replace(/\s*}\s*/g, "}");
        c = c.replace(/\s*\(\s*/g, "(").replace(/\s*\)\s*/g, ")");
        c = c.replace(/\s*;\s*/g, ";");
        return c;
    }

    private agg(t: string): string {
        if (!t) return t;
        let c = this.sem(t);
        c = this.syn(c);
        c = c.replace(/[*_~`#]/g, "");
        c = c.replace(/https?:\/\/(www\.)?([^\/\s]+)(\/[^\s]*)?/gi, "$2");
        const a: [RegExp, string][] = [
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
        for (const [p, x] of a) c = c.replace(p, x);
        c = c.replace(/\n{3,}/g, "\n\n");
        c = c
            .split("\n")
            .map((l) => l.trim())
            .join("\n");
        return c.trim();
    }

    /**
     * Compresses a text string using the specified algorithm.
     */
    compress(
        text: string,
        algorithm: "semantic" | "syntactic" | "aggressive" = "semantic",
    ): CompressionResult {
        if (!text) {
            return {
                og: text,
                comp: text,
                metrics: this.empty(algorithm),
                hash: this.hash(text),
            };
        }

        const cacheKey = `${algorithm}:${this.hash(text)}`;
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

        const originalTokenCount = this.countTokens(text);
        let compressedText: string;

        switch (algorithm) {
            case "semantic":
                compressedText = this.sem(text);
                break;
            case "syntactic":
                compressedText = this.syn(text);
                break;
            case "aggressive":
                compressedText = this.agg(text);
                break;
            default:
                compressedText = text;
        }

        const compressedTokenCount = this.countTokens(compressedText);
        const tokensSaved = originalTokenCount - compressedTokenCount;
        const compressionRatio = compressedTokenCount / originalTokenCount;
        const savingsPercentage = (tokensSaved / originalTokenCount) * 100;
        const estimatedLatency = tokensSaved * this.MS;

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
            hash: this.hash(text),
        };
        this.updateStats(metrics);
        this.store(cacheKey, result);
        return result;
    }

    batch(
        ts: string[],
        a: "semantic" | "syntactic" | "aggressive" = "semantic",
    ): CompressionResult[] {
        return ts.map((t) => this.compress(t, a));
    }

    auto(t: string): CompressionResult {
        if (!t || t.length < 50) return this.compress(t, "semantic");
        const code =
            /\b(function|const|let|var|def|class|import|export)\b/.test(t);
        const urls = /https?:\/\//.test(t);
        const verb = t.split(/\s+/).length > 100;
        let a: "semantic" | "syntactic" | "aggressive";
        if (code || urls) a = "aggressive";
        else if (verb) a = "semantic";
        else a = "syntactic";
        return this.compress(t, a);
    }

    getStats(): CompressionStats {
        return { ...this.stats };
    }

    analyze(t: string): Record<string, CompressionMetrics> {
        const r: Record<string, CompressionMetrics> = {};
        for (const a of ["semantic", "syntactic", "aggressive"] as const) {
            const x = this.compress(t, a);
            r[a] = x.metrics;
        }
        return r;
    }

    reset(): void {
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

    clear(): void {
        this.cache.clear();
    }

    private empty(algorithm: string): CompressionMetrics {
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

    private hash(t: string): string {
        return Bun.hash(t).toString();
    }

    private updateStats(metrics: CompressionMetrics): void {
        this.stats.total++;
        this.stats.originalTokens += metrics.originalTokens;
        this.stats.compressedTokens += metrics.compressedTokens;
        this.stats.saved += metrics.saved;
        this.stats.latency += metrics.latency;
        this.stats.avgRatio = this.stats.compressedTokens / this.stats.originalTokens;
        this.stats.algorithms[metrics.algorithm] =
            (this.stats.algorithms[metrics.algorithm] || 0) + 1;
        this.stats.updated = Date.now();
    }

    private store(k: string, r: CompressionResult): void {
        if (this.cache.size >= this.MAX) {
            const f = this.cache.keys().next().value;
            if (f) this.cache.delete(f);
        }
        this.cache.set(k, r);
    }
}

export const compressionEngine = new MemoryCompressionEngine();
export { MemoryCompressionEngine };
