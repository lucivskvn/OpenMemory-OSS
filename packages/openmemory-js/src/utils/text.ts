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
    // Use Unicode property escapes to support international languages (CJK, etc.)
    const matches = text.match(/\p{L}+/gu);
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
    return uniq.map((t) => `"${t}"`).join(" OR ");
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
