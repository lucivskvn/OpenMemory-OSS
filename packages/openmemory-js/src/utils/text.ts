/**
 * @file Text processing utilities for OpenMemory.
 * Handles tokenization, stemming, synonym expansion, and FTS document building.
 */
const syn_grps = [
    ["prefer", "like", "love", "enjoy", "favor"],
    ["theme", "mode", "style", "layout"],
    ["meeting", "meet", "session", "call", "sync"],
    ["dark", "night", "black"],
    ["light", "bright", "day"],
    ["user", "person", "people", "customer"],
    ["task", "todo", "job"],
    ["note", "memo", "reminder"],
    ["time", "schedule", "when", "date"],
    ["project", "initiative", "plan"],
    ["issue", "problem", "bug"],
    ["document", "doc", "file"],
    ["question", "query", "ask"],
];
const cmap = new Map<string, string>();
const slook = new Map<string, Set<string>>();

for (const grp of syn_grps) {
    const can = grp[0];
    const sset = new Set(grp);
    for (const w of grp) {
        cmap.set(w, can);
        slook.set(can, sset);
    }
}

const stem_rules: Array<[RegExp, string]> = [
    [/ies$/, "y"],
    [/ing$/, ""],
    [/ers?$/, "er"],
    [/ed$/, ""],
    [/s$/, ""],
];
/**
 * Tokenizes text into a flat array of words.
 * Supports unicode property escapes to handle international text (CJK, Emoji).
 *
 * @param text - The raw input string.
 * @returns Array of lowercase tokens.
 */
export const tokenize = (text: string): string[] => {
    if (!text) return [];
    // Use Unicode property escapes to support international languages (CJK, etc.) and numbers
    const matches = text.match(/[\p{L}\p{N}]+/gu);
    return matches ? matches.map((m) => m.toLowerCase()) : [];
};

const stem = (tok: string): string => {
    if (tok.length <= 3) return tok;
    for (const [pat, rep] of stem_rules) {
        if (pat.test(tok)) {
            const st = tok.replace(pat, rep);
            if (st.length >= 3) return st;
        }
    }
    return tok;
};

/**
 * Reduces a token to its canonical form using synonyms and stemming.
 */
export const canonicalizeToken = (tok: string): string => {
    if (!tok) return "";
    const low = tok.toLowerCase();
    const mapped = cmap.get(low);
    if (mapped) return mapped;
    const st = stem(low);
    return cmap.get(st) || st;
};

/**
 * Extracts a list of canonical tokens from a text string.
 */
export const canonicalTokensFromText = (text: string): string[] => {
    const res: string[] = [];
    for (const tok of tokenize(text)) {
        const can = canonicalizeToken(tok);
        if (can && can.length > 1) {
            res.push(can);
        }
    }
    return res;
};

/**
 * Returns a set of synonyms for a given token (including the token itself).
 */
export const synonymsFor = (tok: string): Set<string> => {
    const can = canonicalizeToken(tok);
    return slook.get(can) || new Set([can]);
};

/**
 * Builds a search document string containing canonical tokens and their synonyms.
 * Used for FTS indexing.
 */
export const buildSearchDoc = (text: string): string => {
    const can = canonicalTokensFromText(text);
    const exp = new Set<string>();
    for (const tok of can) {
        exp.add(tok);
        const syns = slook.get(tok);
        if (syns) {
            syns.forEach((s) => exp.add(s));
        }
    }
    return Array.from(exp).join(" ");
};

/**
 * Builds a FTS query string from text.
 * @returns 'OR' separated quoted tokens.
 */
export const buildFtsQuery = (text: string): string => {
    const can = canonicalTokensFromText(text);
    if (!can.length) return "";
    const uniq = Array.from(new Set(can.filter((t) => t.length > 1)));
    // Escape double quotes to prevent FTS injection
    return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
};

/**
 * Returns a set of unique canonical tokens from text.
 */
export const canonicalTokenSet = (text: string): Set<string> => {
    return new Set(canonicalTokensFromText(text));
};

/**
 * Expands a list of tokens with their synonyms.
 */
export const addSynonymTokens = (toks: Iterable<string>): Set<string> => {
    const res = new Set<string>();
    for (const tok of toks) {
        res.add(tok);
        const syns = slook.get(tok);
        if (syns) {
            syns.forEach((s) => res.add(canonicalizeToken(s)));
        }
    }
    return res;
};

/**
 * Deterministic SimHash generator for text duplication detection.
 * Uses 64-bit FNV-1a for high entropy and collision resistance.
 */
export const computeSimhash = (text: string): string => {
    const tokens = tokenize(text);
    if (tokens.length === 0) return "0".repeat(64);

    const v = new Int32Array(64).fill(0);
    for (const t of tokens) {
        // FNV-1a 64-bit
        let h = 0xcbf29ce484222325n;
        for (let i = 0; i < t.length; i++) {
            h ^= BigInt(t.charCodeAt(i));
            h = BigInt.asUintN(64, h * 0x100000001b3n);
        }
        for (let i = 0; i < 64; i++) {
            if ((h >> BigInt(i)) & 1n) v[i]++;
            else v[i]--;
        }
    }
    let sh = "";
    for (let i = 0; i < 64; i++) sh += v[i] > 0 ? "1" : "0";
    return sh;
};

/**
 * Extracts essential parts of a text up to maxLen characters.
 */
export const extractEssence = (raw: string, maxLen: number): string => {
    if (raw.length <= maxLen) return raw;
    const sents = raw
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);
    if (sents.length === 0) return raw.slice(0, maxLen);
    const scoreSent = (s: string, idx: number): number => {
        let sc = 0;
        if (idx === 0) sc += 10;
        if (idx === 1) sc += 5;
        if (/^#+\s/.test(s) || /^[A-Z][A-Z\s]+:/.test(s)) sc += 8;
        if (/^[A-Z][a-z]+:/i.test(s)) sc += 6;
        if (/\d{4}-\d{2}-\d{2}/.test(s)) sc += 7;
        if (
            /\b(bought|visited|went|learned|discovered|found|saw|met)\b/i.test(
                s,
            )
        )
            sc += 4;
        if (s.length < 80) sc += 2;
        return sc;
    };
    const scored = sents.map((s, idx) => ({
        text: s,
        score: scoreSent(s, idx),
        idx,
    }));
    scored.sort((a, b) => b.score - a.score);
    const selected: typeof scored = [];
    let currentLen = 0;
    for (const item of scored) {
        if (currentLen + item.text.length + 2 <= maxLen) {
            selected.push(item);
            currentLen += item.text.length + 2;
        }
    }
    selected.sort((a, b) => a.idx - b.idx);
    return selected.map((s) => s.text).join(" ");
};

const STOP_WORDS = new Set([
    "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "with", "at", "by", "is", "it",
    "be", "as", "are", "was", "were", "from", "that", "this", "these", "those", "but", "if", "then",
    "so", "than", "into", "over", "under", "about", "via", "vs", "not", "their", "there", "when",
    "where", "how", "what", "which", "who", "whom", "will", "would", "can", "could", "should", "some",
    "any", "all", "each", "every", "few", "more", "most", "other", "such", "no", "nor", "only", "own",
    "same", "too", "very", "just", "now", "here", "why", "because", "while", "until", "again",
    "once", "twice", "both", "neither", "either",
]);

/**
 * Extracts the top K keywords from text.
 * Uses unicode-aware tokenization for international language support.
 */
export const topKeywords = (t: string, k = 5): string[] => {
    const words = tokenize(t).filter((w) => !STOP_WORDS.has(w) && w.length > 1);
    if (!words.length) return [];

    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);

    return Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, k)
        .map(([w]) => w);
};

/**
 * Quickly summarizes text by selecting important sentences.
 */
export const summarizeQuick = (t: string): string => {
    const sents = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (!sents.length) return t;

    const score = (s: string) =>
        topKeywords(s, 6).length + Math.min(3, s.match(/[,;:]/g)?.length || 0);

    const top = sents
        .map((s, i) => ({ s, i, sc: score(s) }))
        .sort((a, b) => b.sc - a.sc || a.i - b.i)
        .slice(0, Math.min(3, Math.ceil(sents.length / 3)))
        .sort((a, b) => a.i - b.i)
        .map((x) => x.s)
        .join(" ");

    return top || sents[0];
};
