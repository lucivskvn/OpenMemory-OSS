/**
 * Vector utility functions to break circular dependencies between DB and Embedding logic.
 */

/**
 * Calculate cosine similarity between two vectors.
 */
export const cosineSimilarity = (a: number[], b: number[]) => {
    if (a.length !== b.length) return 0;
    let dot = 0,
        na = 0,
        nb = 0;
    for (let i = 0; i < a.length; i++) {
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
    const b = Buffer.allocUnsafe(v.length * 4);
    for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i], i * 4);
    return b;
};

/**
 * Convert a Buffer (Float32LE) back to a numeric vector.
 */
export const bufferToVector = (b: Buffer | Uint8Array) => {
    const v: number[] = [];
    // Ensure we have a Buffer to use readFloatLE, or use DataView if we fully ditch Buffer
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
    for (let i = 0; i < buf.length; i += 4) v.push(buf.readFloatLE(i));
    return v;
};
