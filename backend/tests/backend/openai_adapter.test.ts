import { describe, it, expect } from "bun:test";
import { env } from "../../src/core/cfg";
import { transcribeAudioWithOpenAI } from "../../src/core/openai_adapter";

describe("OpenAI adapter", () => {
    it("throws when OPENAI key missing", async () => {
        const orig = env.openai_key;
        try {
            env.openai_key = undefined as any;
            await expect(transcribeAudioWithOpenAI(Buffer.from("x"))).rejects.toThrow("OpenAI key missing");
        } finally {
            env.openai_key = orig;
        }
    });

    it("falls back to REST fetch and returns text", async () => {
        const origKey = env.openai_key;
        const origFetch = globalThis.fetch;
        try {
            env.openai_key = "test-key";
            // Mock fetch to simulate REST transcription response
            globalThis.fetch = async (input: any, init?: any) => {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ text: "mock transcription" }),
                };
            };

            const res = await transcribeAudioWithOpenAI(Buffer.from("dummy"));
            expect(res).toBe("mock transcription");
        } finally {
            env.openai_key = origKey;
            globalThis.fetch = origFetch;
        }
    });
});
