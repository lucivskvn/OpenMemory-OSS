export * from "./crypto";

export const now = (): number => Date.now();
export const rid = (): string => crypto.randomUUID();
export const cos_sim = (a: Float32Array, b: Float32Array): number => {
    let dot = 0,
        na = 0,
        nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i],
            y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d ? dot / d : 0;
};
export const j = JSON.stringify;
export const p = <t = any>(x: string): t => JSON.parse(x);
export const vec_to_buf = (v: number[]): Buffer => {
    const f32 = new Float32Array(v);
    return Buffer.from(f32.buffer);
};
export const buf_to_vec = (buf: Buffer): Float32Array => {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

// Bun-specific helpers (file I/O wrappers and runtime introspection)
export const isBun = (): boolean => typeof Bun !== "undefined";
export const bunVersion = (): string =>
    isBun() ? (Bun as any).version || "unknown" : "N/A";
export const bunRevision = (): string =>
    isBun() ? (Bun as any).revision || "unknown" : "N/A";

export const readFile = async (path: string): Promise<ArrayBuffer> =>
    await Bun.file(path).arrayBuffer();
export const writeFile = async (
    path: string,
    data: string | ArrayBuffer | Uint8Array,
): Promise<void> => {
    await Bun.write(path, data as any);
};
export const fileExists = async (path: string): Promise<boolean> =>
    await Bun.file(path).exists();

export const measureTime = async <T>(
    fn: () => Promise<T>,
): Promise<{ result: T; duration: number }> => {
    const start = Date.now();
    const result = await fn();
    return { result, duration: Date.now() - start };
};
