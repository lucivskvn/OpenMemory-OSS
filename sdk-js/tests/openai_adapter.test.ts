import { describe, it, expect } from "bun:test";
import { transcribeAudioWithOpenAI } from "../src/core/openai_adapter";

describe("SDK OpenAI adapter", () => {
    it("throws when key missing", async () => {
        const orig = process.env.OPENAI_API_KEY;
        try {
            delete process.env.OPENAI_API_KEY;
            await expect(transcribeAudioWithOpenAI(Buffer.from("x"))).rejects.toThrow("OpenAI key missing");
        } finally {
            if (orig) process.env.OPENAI_API_KEY = orig;
        }
    });
});
