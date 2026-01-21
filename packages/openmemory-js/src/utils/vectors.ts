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
 * Resizes a vector to a target dimensionality using interpolation/averaging.
 * Ensures the output vector is normalized.
 */
export function resizeVector(v: number[], targetDim: number): number[] {
    if (v.length <= targetDim) return v;
    const resized = new Float32Array(targetDim);
    const blockSize = v.length / targetDim;

    for (let i = 0; i < targetDim; i++) {
        const start = Math.floor(i * blockSize);
        const end = Math.floor((i + 1) * blockSize);
        let sum = 0;
        let count = 0;
        for (let j = start; j < end && j < v.length; j++) {
            sum += v[j];
            count++;
        }
        resized[i] = count > 0 ? sum / count : 0;
    }

    // Convert to number array and normalize
    return normalize(Array.from(resized));
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
    if (!na || !nb) return 0;
    const res = dot / (Math.sqrt(na) * Math.sqrt(nb));
    return Math.max(-1, Math.min(1, res));
};

/**
 * Convert a numeric vector to a Uint8Array (Float32LE).
 */
export const vectorToUint8Array = (v: number[]) => {
    const f32 = new Float32Array(v);
    return new Uint8Array(f32.buffer);
};
export const vectorToBuffer = vectorToUint8Array;

/**
 * Convert a Uint8Array/string back to a numeric vector.
 */
export const bufferToVector = (b: Uint8Array | string): number[] => {
    // Handle Postgres vector string format "[1,2,3]"
    if (typeof b === "string") {
        try {
            const parsed = JSON.parse(b);
            if (Array.isArray(parsed)) return parsed;
        } catch {
            /* Fallback */
        }
    }

    const buf = b instanceof Uint8Array
        ? b
        : typeof b === "string"
            ? new TextEncoder().encode(b)
            : new Uint8Array(b as ArrayBuffer);

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
        const aligned = new Uint8Array(buf.byteLength);
        aligned.set(buf);
        return Array.from(new Float32Array(aligned.buffer));
    }

    // Fallback for misaligned or strange lengths
    const v: number[] = [];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < buf.byteLength - 3; i += 4) {
        v.push(view.getFloat32(i, true));
    }
    return v;
};

/**
 * Convert a Uint8Array to Float32Array without copying to a standard Array.
 * Zero-copy where possible.
 */
export const bufferToFloat32Array = (b: Uint8Array): Float32Array => {
    if (b.byteLength % 4 !== 0) {
        throw new Error(`Invalid buffer length for Float32Array: ${b.byteLength}`);
    }
    if (b.byteOffset % 4 !== 0) {
        // Copy to ensure alignment
        const copy = new Uint8Array(b.byteLength);
        copy.set(b);
        return new Float32Array(copy.buffer);
    }
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
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
export const toVectorString = (v: number[] | Float32Array | Uint8Array | null | undefined): string | null => {
    if (!v) return null;
    if (v instanceof Uint8Array) {
        return `[${bufferToVector(v).join(",")}]`;
    }
    if (v instanceof Float32Array) {
        return `[${Array.prototype.join.call(v, ",")}]`;
    }
    return `[${(v as number[]).join(",")}]`;
};
