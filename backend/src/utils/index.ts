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

export const parse_int = (x: any, d: number) => Number.isFinite(+x) ? Math.floor(+x) : d;
export const parse_f = (x: any, d: number) => (Number.isFinite(+x) ? +x : d);
export const parse_bool = (x: any, d: boolean) => x === "true" ? true : x === "false" ? false : d;
export const clamp_f = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const clamp_i = (v: number, a: number, b: number) => Math.min(b, Math.max(a, Math.floor(v)));
