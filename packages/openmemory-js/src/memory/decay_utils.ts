import { createHash } from "node:crypto";
import { canonical_tokens_from_text } from "../utils/text";

export const compress_vector = (v: number[], f: number, min_dim: number, max_dim: number): number[] => {
    const tgt_dim = Math.max(min_dim, Math.min(max_dim, Math.floor(v.length * Math.max(0, Math.min(1, f)))));
    if (tgt_dim >= v.length) return [...v];

    const res: number[] = [];
    const bucket_size = Math.ceil(v.length / tgt_dim);
    for (let i = 0; i < v.length; i += bucket_size) {
        const bucket = v.slice(i, i + bucket_size);
        const sum = bucket.reduce((a, b) => a + b, 0);
        res.push(sum / bucket.length);
    }

    // Normalize
    const norm = Math.sqrt(res.reduce((a, b) => a + b * b, 0));
    return norm > 0 ? res.map(x => x / norm) : res;
};

export const compress_summary = (t: string, f: number, layers: number): string => {
    if (!t || f > 0.8) return t;
    // Simplified regex to avoid potential backtracking performance issues.
    const sentences = t.split(/[.!?]\s+/);
    if (sentences.length <= 1) return t;

    // Simple extractive summarization based on position and length
    const keep_count = Math.max(1, Math.floor(sentences.length * f));
    return sentences.slice(0, keep_count).join(". ") + ".";
};

const hash_to_vec = (s: string, d: number): number[] => {
    // NOTE: SHA-256 is used here for deterministic pseudo-random
    // vector generation for memory fingerprinting.
    const vec: number[] = [];
    let h = createHash("sha256").update(s).digest();
    for (let i = 0; i < d; i++) {
        const h_idx = i % 32;
        if (i > 0 && h_idx === 0) {
            // Re-hash to get fresh entropy for the next 32 dimensions
            h = createHash("sha256").update(h).digest();
        }
        const b1 = h[h_idx];
        const b2 = h[(h_idx + 1) % 32];
        // Combine both bytes and avoid 32-byte period collapse
        const val = ((b1 ^ b2) / 255.0) * 2 - 1;
        vec.push(val);
    }
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
    return norm > 0 ? vec.map(x => x / norm) : vec;
};

export const fingerprint_mem = (m: any, d: number): { vector: number[], summary: string } => {
    const content = m.summary || m.content || "";
    const tokens = canonical_tokens_from_text(content);
    const summary = tokens.slice(0, 5).join(" ");
    const vector = hash_to_vec(m.id + "|" + content, d);
    return { vector, summary };
};
