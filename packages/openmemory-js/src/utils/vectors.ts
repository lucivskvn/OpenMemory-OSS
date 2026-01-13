/**
 * @file Vector utility functions for OpenMemory.
 * Handles normalization, similarity, and buffer conversions.
 */
import { logger } from "./logger";

/**
 * Normalizes a vector to unit length (L2 norm).
 */
export function normalize(v: number[]): number[] {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    if (n === 0) return v;
    const inv = 1 / Math.sqrt(n);
    // Optimized map
    const len = v.length;
    const res = new Array(len);
    for (let i = 0; i < len; i++) res[i] = v[i] * inv;
    return res;
}

/**
 * Calculate cosine similarity between two vectors (Array or Float32Array).
 */
export const cosineSimilarity = (a: number[] | Float32Array, b: number[] | Float32Array) => {
    if (a.length !== b.length) return 0;

    // Manual loop is fastest for V8 optimization
    let dot = 0, na = 0, nb = 0;
    const len = a.length;

    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

/**
 * Convert a numeric vector to a Buffer (Float32LE).
 */
export const vectorToBuffer = (v: number[]) => {
    const f32 = new Float32Array(v);
    return Buffer.from(f32.buffer);
};

/**
 * Convert a Buffer (Float32LE) back to a numeric vector.
 * Optimized to use TypedArray view instead of loop-based readFloatLE.
 */
export const bufferToVector = (b: Buffer | Uint8Array | string): number[] => {
    // Handle Postgres vector string format "[1,2,3]"
    if (typeof b === "string") {
        try {
            const parsed = JSON.parse(b);
            if (Array.isArray(parsed)) return parsed;
        } catch {
            /* Fallback */
        }
    }

    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);

    // Fast path: use Float32Array view if aligned
    if (buf.byteLength % 4 === 0) {
        if (buf.byteOffset % 4 === 0) {
            const f32 = new Float32Array(
                buf.buffer,
                buf.byteOffset,
                buf.byteLength / 4,
            );
            return Array.from(f32);
        }
        // Copy if misaligned
        return Array.from(new Float32Array(new Uint8Array(buf).buffer));
    }

    // Fallback for misaligned buffers (rare)
    const v: number[] = [];
    for (let i = 0; i < buf.length - 3; i += 4) {
        v.push(buf.readFloatLE(i));
    }
    return v;
};

/**
 * Convert a Buffer/Uint8Array to Float32Array without copying to a standard Array.
 * Zero-copy where possible.
 */
export const bufferToFloat32Array = (b: Buffer | Uint8Array): Float32Array => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
    if (buf.byteLength % 4 !== 0) {
        throw new Error(`Invalid buffer length for Float32Array: ${buf.byteLength}`);
    }
    if (buf.byteOffset % 4 !== 0) {
        // Copy to ensure alignment
        const copy = new Uint8Array(buf.byteLength);
        copy.set(new Uint8Array(buf));
        return new Float32Array(copy.buffer);
    }
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

/**
 * Calculates the mean vector of a set of vectors.
 */
export const aggregateVectors = (vecs: number[][]): number[] => {
    const n = vecs.length;
    if (!n) throw new Error("no vectors to aggregate");
    if (n === 1) return vecs[0].slice();

    const d = vecs[0].length;
    const r = new Array(d).fill(0);

    let count = 0;
    for (const v of vecs) {
        if (v.length !== d) {
            logger.warn(
                `[VECTORS] Dim mismatch in aggregation: expected ${d}, got ${v.length}`,
            );
            continue;
        }
        for (let i = 0; i < d; i++) r[i] += v[i];
        count++;
    }

    if (count === 0) return r;

    const rc = 1 / count;
    for (let i = 0; i < d; i++) r[i] *= rc;
    return r;
};

/**
 * Format a vector for Postgres usage (string representation "[1,2,3]").
 */
export const toVectorString = (v: number[] | Float32Array | Buffer | null | undefined): string | null => {
    if (!v) return null;
    if (Buffer.isBuffer(v)) {
        // Assume it's a binary float32 array we need to convert to numbers first? 
        // Or if it's already a string buffer?
        // Usually we pass pre-calculated meanVec which is number[] or Float32Array. 
        // If it's a Buffer, we convert to vector first.
        return `[${bufferToVector(v).join(",")}]`;
    }
    if (Array.isArray(v)) return `[${v.join(",")}]`;
    return `[${Array.from(v).join(",")}]`;
};
