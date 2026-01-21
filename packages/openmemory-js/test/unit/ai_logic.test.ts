
import { describe, expect, mock, test } from "bun:test";
import { OpenAIGenerator, GeminiGenerator, OllamaGenerator } from "../../src/ai/adapters";
import { nodeSectorMap, getLgCfg } from "../../src/ai/graph";

// Mock dependencies
mock.module("../../src/core/db", () => ({
    vectorStore: {
        searchSimilar: mock(() => Promise.resolve([])),
        storeVector: mock(() => Promise.resolve())
    },
    transaction: { run: mock((fn: any) => fn()) }
}));

mock.module("../../src/core/cfg", () => ({
    env: {
        llmProvider: "openai",
        openaiApiKey: "sk-test",
        geminiApiKey: "AIza-test",
        ollamaUrl: "http://localhost:11434"
    }
}));

describe("AI Unit Tests", () => {
    describe("LLM Adapters", () => {
        test("OpenAI Generator initialization", () => {
            const adapter = new OpenAIGenerator("test-key");
            expect(adapter).toBeDefined();
            expect(adapter.model).toBeDefined();
        });

        test("Gemini Generator initialization", () => {
            const adapter = new GeminiGenerator("test-key");
            expect(adapter).toBeDefined();
        });

        test("Ollama Generator initialization", () => {
            const adapter = new OllamaGenerator("http://localhost:11434");
            expect(adapter).toBeDefined();
        });
    });

    describe("LangGraph Integration", () => {
        test("nodeSectorMap is correctly defined", () => {
            expect(nodeSectorMap).toBeDefined();
            expect(nodeSectorMap.observe).toBe("episodic");
            expect(nodeSectorMap.plan).toBe("semantic");
            expect(nodeSectorMap.reflect).toBe("reflective");
            expect(nodeSectorMap.act).toBe("procedural");
            expect(nodeSectorMap.emotion).toBe("emotional");
        });

        test("getLgCfg returns valid configuration", () => {
            const cfg = getLgCfg();
            expect(cfg.success).toBe(true);
            expect(cfg.config.nodes).toContain("observe");
            expect(cfg.config.nodes).toContain("plan");
            expect(cfg.config.nodes).toContain("reflect");
            expect(cfg.config.edges.length).toBeGreaterThan(0);
        });
    });
});

