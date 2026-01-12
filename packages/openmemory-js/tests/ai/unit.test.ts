import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { GeminiGenerator, OllamaGenerator, OpenAIGenerator, ProviderError } from "../../src/ai/adapters";
import { USER_AGENT } from "../../src/core/cfg";
import { storeNodeMem, nodeSectorMap } from "../../src/ai/graph";
import { createMcpServer } from "../../src/ai/mcp";

// ==========================================
// Mocks for Logic Tests (Graph/MCP)
// ==========================================
// We use mock.module to intercept imports. 
// Note: This affects the whole file, so we group logic tests here.

function mockAsync<T extends (...args: any[]) => any>(fn: T) {
    return mock(fn);
}

mock.module("../../src/memory/hsg", () => ({
    addHsgMemory: mockAsync(async () => ({ id: "mem-123", primarySector: "episodic", sectors: ["episodic"] })),
    hsgQuery: mockAsync(async () => []),
}));

mock.module("../../src/core/db", () => ({
    q: {
        getMems: { all: mockAsync(async () => []) },
        allMemBySectorAndTag: { all: mockAsync(async () => []) },
    },
    vectorStore: {
        getVectorsByIds: mockAsync(async () => []),
    }
}));

// ==========================================
// Mocks for LLM Providers (OpenAI)
// ==========================================
const mockCreate = mock();
mock.module("openai", () => {
    return {
        default: class {
            chat = {
                completions: {
                    create: mockCreate
                }
            }
        }
    };
});


describe("AI Unit Suite", () => {

    describe("AI Logic Hardening", () => {
        describe("Graph Module", () => {
            test("storeNodeMem handles basic storage", async () => {
                const res = await storeNodeMem({
                    node: "observe",
                    content: "Saw a bird",
                    namespace: "test-ns",
                });
                expect((res.memory as any)!.node).toBe("observe");
                expect((res.memory as any)!.namespace).toBe("test-ns");
                expect(res.memory!.primarySector).toBe("episodic"); // From nodeSectorMap
            });

            test("storeNodeMem throws GraphError (via AppError) on invalid input", async () => {
                try {
                    // @ts-ignore - intentional bad input
                    await storeNodeMem({ node: "", content: "" });
                } catch (e: any) {
                    expect(e.message).toContain("node is required");
                    expect(e.statusCode).toBe(400);
                }
            });

            test("nodeSectorMap is complete", () => {
                expect(nodeSectorMap["observe"]).toBe("episodic");
                expect(nodeSectorMap["plan"]).toBe("semantic");
                expect(nodeSectorMap["act"]).toBe("procedural");
            });
        });

        describe("MCP Server", () => {
            const srv = createMcpServer();

            test("Can initialize MCP server", () => {
                expect(srv).toBeDefined();
            });
        });
    });

    describe("LLM Providers (OpenAI Mock)", () => {
        let generator: OpenAIGenerator;

        beforeEach(() => {
            mockCreate.mockReset();
            generator = new OpenAIGenerator("test-key");
        });

        test("generate returns content on success", async () => {
            mockCreate.mockResolvedValue({
                choices: [{ message: { content: "Hello world" } }]
            });

            const result = await generator.generate("Hi");
            expect(result).toBe("Hello world");
            expect(mockCreate).toHaveBeenCalledTimes(1);
        });

        test("generate retries on rate limit (429)", async () => {
            // Fail once, then succeed
            mockCreate
                .mockRejectedValueOnce({ status: 429, message: "Too Many Requests" })
                .mockResolvedValueOnce({ choices: [{ message: { content: "Recovered" } }] });

            const result = await generator.generate("Hi");
            expect(result).toBe("Recovered");
            expect(mockCreate).toHaveBeenCalledTimes(2);
        });

        test("generate throws immediately on auth error (401)", async () => {
            mockCreate.mockRejectedValue({ status: 401, message: "Invalid Key" });

            try {
                await generator.generate("Hi");
                expect.unreachable("Should have thrown");
            } catch (e: any) {
                expect(e).toBeInstanceOf(ProviderError);
                expect(e.code).toBe("AUTH_ERROR");
                expect(e.retryable).toBe(false);
                expect(mockCreate).toHaveBeenCalledTimes(1); // No retry
            }
        });
    });

    describe("AI Adapters (Fetch Mock)", () => {
        const originalFetch = global.fetch;

        beforeEach(() => {
            // mock.restore(); // Be careful with this if it affects other mocks
        });

        afterEach(() => {
            global.fetch = originalFetch;
        });

        describe("GeminiGenerator", () => {
            test("uses correct User-Agent and timeout", async () => {
                const mockFetch = mock(async (url, opts) => {
                    return new Response(JSON.stringify({
                        candidates: [{ content: { parts: [{ text: "Hello Gemini" }] } }]
                    }), { status: 200 });
                });
                global.fetch = mockFetch as any;

                const gen = new GeminiGenerator("test-key");
                const res = await gen.generate("Hi");

                expect(res).toBe("Hello Gemini");
                expect(mockFetch).toHaveBeenCalled();
                // Check User-Agent
                const calls = mockFetch.mock.calls;
                const headers = calls[0][1].headers as any;
                expect(headers["User-Agent"]).toBe(USER_AGENT);
                expect(headers["x-goog-api-key"]).toBe("test-key");
                // Signal should be present
                expect(calls[0][1].signal).toBeDefined();
            });

            test("handles provider error correctly", async () => {
                const mockFetch = mock(async () => {
                    return new Response(JSON.stringify({
                        error: { code: 400, message: "Bad Request" }
                    }), { status: 400, statusText: "Bad Request" });
                });
                global.fetch = mockFetch as any;
                const gen = new GeminiGenerator("test-key");

                try {
                    await gen.generate("fail");
                } catch (e: any) {
                    expect(e).toBeInstanceOf(ProviderError);
                    expect(e.message).toContain("Bad Request");
                    expect(e.provider).toBe("gemini");
                }
            });
        });

        describe("OllamaGenerator", () => {
            test("uses correct User-Agent", async () => {
                const mockFetch = mock(async (url, opts) => {
                    return new Response(JSON.stringify({
                        response: "Hello Ollama",
                        done: true
                    }), { status: 200 });
                });
                global.fetch = mockFetch as any;

                const gen = new OllamaGenerator("http://localhost:11434");
                const res = await gen.generate("Hi");

                expect(res).toBe("Hello Ollama");
                const calls = mockFetch.mock.calls;
                const headers = calls[0][1].headers as any;
                expect(headers["User-Agent"]).toBe(USER_AGENT);
            });
        });
    });

});
