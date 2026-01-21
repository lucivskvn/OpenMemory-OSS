import { describe, expect, beforeAll, afterAll, it, spyOn, mock } from "bun:test";
import { cleanupIfSuccess, waitForDb, getUniqueDbPath } from "../test_utils";
import { closeDb } from "../../src/core/db";
import { reloadConfig, env } from "../../src/core/cfg";
import { OllamaGenerator } from "../../src/ai/adapters";
import { getEmbeddingProvider } from "../../src/memory/embed";
import { getModel } from "../../src/core/models";

describe("Ollama Integration & Hardening Verification", () => {
    const DB_PATH = getUniqueDbPath("ollama");

    beforeAll(async () => {
        await closeDb();
        process.env.OM_DB_PATH = DB_PATH;
        process.env.OM_OLLAMA_MODEL = "llama3.2:latest";
        process.env.OM_OLLAMA_EMBED_MODEL = "nomic-embed-text:latest";
        reloadConfig();
        await waitForDb();
    }, 10000);

    afterAll(async () => {
        await cleanupIfSuccess(DB_PATH);
    });

    it("should decouple generation and embedding models", () => {
        expect(env.ollamaModel).toBe("llama3.2:latest");
        expect(env.ollamaEmbedModel).toBe("nomic-embed-text:latest");

        const model = getModel("semantic", "ollama");
        expect(model).toBe("nomic-embed-text:latest");
    });

    it("should use /api/chat for instruction-based prompts in OllamaGenerator", async () => {
        const generator = new OllamaGenerator("http://localhost:11434", "llama3.2:latest");

        // Mock fetch
        const originalFetch = global.fetch;
        global.fetch = mock(async (url: string, init?: RequestInit) => {
            const body = JSON.parse(init?.body as string);
            
            if (url.includes("/api/chat")) {
                return new Response(JSON.stringify({
                    model: "llama3.2:latest",
                    message: { role: "assistant", content: "Chat response" },
                    done: true
                }));
            }
            
            return new Response(JSON.stringify({
                model: "llama3.2:latest",
                response: "Generate response",
                done: true
            }));
        }) as any;

        try {
            // Case 1: Simple prompt (should use /api/generate)
            const res1 = await generator.generate("Hello world");
            expect(res1).toBe("Generate response");
            expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/generate"), expect.any(Object));

            // Case 2: Instruction-based prompt (should use /api/chat)
            const res2 = await generator.generate("Instructions: Summarize this context: Some content");
            expect(res2).toBe("Chat response");
            expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/chat"), expect.any(Object));
        } finally {
            global.fetch = originalFetch;
        }
    });

    it("should correctly handle JSON generation via /api/generate", async () => {
        const generator = new OllamaGenerator("http://localhost:11434", "llama3.2:latest");

        const originalFetch = global.fetch;
        global.fetch = mock(async () => {
            return new Response(JSON.stringify({
                model: "llama3.2:latest",
                response: JSON.stringify({ summary: "JSON response" }),
                done: true
            }));
        }) as any;

        try {
            const res = await generator.generateJSON<{ summary: string }>("Summarize this");
            expect(res.summary).toBe("JSON response");
            expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/generate"), expect.any(Object));
        } finally {
            global.fetch = originalFetch;
        }
    });
});
