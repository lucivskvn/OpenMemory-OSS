import { getEncoding, Tiktoken } from "js-tiktoken";

export type chunk = {
    text: string;
    start: number;
    end: number;
    tokens: number;
};

let encoder: Tiktoken | null = null;

function get_encoder(): Tiktoken | null {
    if (encoder) return encoder;
    try {
        encoder = getEncoding("cl100k_base");
        return encoder;
    } catch (e) {
        console.warn("[CHUNKING] Failed to initialize tiktoken encoder, falling back to character estimate:", e);
        return null;
    }
}

const est = (t: string) => {
    const enc = get_encoder();
    if (enc) {
        // Use disallowedSpecial: [] to treat special tokens as normal text
        return enc.encode(t, "all", []).length;
    }
    return Math.ceil(t.length / 4);
};

export const chunk_text = (txt: string, tgt = 768, ovr = 0.1): chunk[] => {
    const tot = est(txt);
    if (tot <= tgt)
        return [{ text: txt, start: 0, end: txt.length, tokens: tot }];

    const tch = tgt * 4,
        och = Math.floor(tch * ovr);
    const paras = txt.split(/\n\n+/);

    const chks: chunk[] = [];
    let cur = "",
        cs = 0,
        cur_tokens = 0;

    for (const p of paras) {
        const sents = p.split(/(?<=[.!?])\s+/);
        for (const s of sents) {
            const s_tokens = est(s);
            const pot_tokens = cur_tokens + (cur ? 1 : 0) + s_tokens; // +1 for the space

            if (pot_tokens > tgt && cur.length > 0) {
                chks.push({
                    text: cur,
                    start: cs,
                    end: cs + cur.length,
                    tokens: cur_tokens,
                });
                const ovt = cur.slice(-och);
                const ovt_tokens = est(ovt);
                cur = ovt + " " + s;
                cs = cs + cur.length - ovt.length - 1;
                cur_tokens = ovt_tokens + 1 + s_tokens;
            } else {
                cur = cur + (cur ? " " : "") + s;
                cur_tokens = pot_tokens;
            }
        }
    }

    if (cur.length > 0)
        chks.push({
            text: cur,
            start: cs,
            end: cs + cur.length,
            tokens: cur_tokens,
        });
    return chks;
};

export const agg_vec = (vecs: number[][]): number[] => {
    const n = vecs.length;
    if (!n) throw new Error("no vecs");
    if (n === 1) return vecs[0].slice();

    const d = vecs[0].length,
        r = new Array(d).fill(0);
    for (const v of vecs) for (let i = 0; i < d; i++) r[i] += v[i];
    const rc = 1 / n;
    for (let i = 0; i < d; i++) r[i] *= rc;
    return r;
};

export const join_chunks = (cks: chunk[]) =>
    cks.length ? cks.map((c) => c.text).join(" ") : "";
