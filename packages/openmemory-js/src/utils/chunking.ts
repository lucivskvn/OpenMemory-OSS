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

/**
 * Splits a paragraph into chunks based on token limit and overlap.
 */
function process_paragraph_sentences(
    p: string,
    chks: chunk[],
    tgt: number,
    och: number,
    state: { cur: string; cs: number; cur_tokens: number }
) {
    const sents = p.split(/(?<=[.!?])\s+/);
    for (const s of sents) {
        const s_tokens = est(s);
        const pot_tokens = state.cur_tokens + (state.cur ? 1 : 0) + s_tokens;

        if (pot_tokens > tgt && state.cur.length > 0) {
            chks.push({
                text: state.cur,
                start: state.cs,
                end: state.cs + state.cur.length,
                tokens: state.cur_tokens,
            });
            const ovt = state.cur.slice(-och);
            const ovt_tokens = est(ovt);
            state.cur = ovt + " " + s;
            state.cs = state.cs + state.cur.length - ovt.length - 1;
            state.cur_tokens = ovt_tokens + 1 + s_tokens;
        } else {
            state.cur = state.cur + (state.cur ? " " : "") + s;
            state.cur_tokens = pot_tokens;
        }
    }
}

export const chunk_text = (txt: string, tgt = 768, ovr = 0.1): chunk[] => {
    const tot = est(txt);
    if (tot <= tgt)
        return [{ text: txt, start: 0, end: txt.length, tokens: tot }];

    const tch = tgt * 4,
        och = Math.floor(tch * ovr);
    const paras = txt.split(/\n\n+/);

    const chks: chunk[] = [];
    const state = { cur: "", cs: 0, cur_tokens: 0 };

    for (const p of paras) {
        process_paragraph_sentences(p, chks, tgt, och, state);
    }

    if (state.cur.length > 0)
        chks.push({
            text: state.cur,
            start: state.cs,
            end: state.cs + state.cur.length,
            tokens: state.cur_tokens,
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
