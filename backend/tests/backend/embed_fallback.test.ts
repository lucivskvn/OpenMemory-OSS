import { describe, it, expect } from "bun:test";
import { env } from "../../src/core/cfg";
import { get_sem_emb, gen_syn_emb, emb_batch_with_fallback } from "../../src/memory/embed";

// Ensure fallback to synthetic when provider missing
describe("embed fallback behavior", () => {
    it("falls back to synthetic when OpenAI key is missing", async () => {
        const origKind = env.emb_kind;
        const origOpenai = env.openai_key;
        try {
            env.emb_kind = "openai" as any;
            env.openai_key = undefined;
            env.embedding_fallback = ["synthetic"] as any;

            const txt = "Fallback test text";
            const v = await get_sem_emb(txt, "semantic");
            const syn = gen_syn_emb(txt, "semantic");
            expect(v).toEqual(syn);
        } finally {
            env.emb_kind = origKind;
            env.openai_key = origOpenai;
        }
    });

    it("emb_batch_with_fallback returns synthetic for unknown provider", async () => {
        const origKind = env.emb_kind;
        try {
            env.emb_kind = "bogus" as any;
            env.embedding_fallback = ["synthetic"] as any;
            const res = await emb_batch_with_fallback({ semantic: "a", episodic: "b" });
            expect(Object.keys(res)).toEqual(["semantic", "episodic"]);
            expect(res.semantic).toEqual(gen_syn_emb("a", "semantic"));
        } finally {
            env.emb_kind = origKind;
        }
    });
});
