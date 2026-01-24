/**
 * @file adapters.ts
 * @description LLM Generation Adapters for OpenMemory (OpenAI, Anthropic, Gemini, Ollama).
 * @audited 2026-01-19
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { env, USER_AGENT } from "../core/cfg";
import { getPersistedConfig } from "../core/persistedCfg";
import { embed, getEmbeddingInfo, getEmbeddingProvider } from "../memory/embed";
import { logger, redact } from "../utils/logger";
import { CircuitBreaker, withResilience } from "../utils/retry";
import { GeminiCandidate, GeminiResponse, OllamaChatResponse, OllamaResponse } from "./types";

const DEFAULT_TIMEOUT = 30000;
const OLLAMA_TIMEOUT = env.ollamaTimeout;

export { embed, getEmbeddingInfo, getEmbeddingProvider };





/**
 * Interface for LLM Text Generation Adapters.
 * Provides a unified contract for different AI providers (OpenAI, Anthropic, Gemini, Ollama).
 */
export interface GenerationAdapter {
    /**
     * Generates text based on a prompt.
     * @param prompt - The input prompt.
     * @param options - Generation options (tokens, temp, signal).
     */
    generate(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<string>;

    /**
     * Generates specific JSON output adhering to an optional schema.
     * @param prompt - The input prompt.
     * @param schema - Optional JSON schema object.
     * @param options - Generation options.
     */
    generateJSON<T>(
        prompt: string,
        schema?: Record<string, unknown>,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<T>;

    /** Token usage for the last operation */
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };

    /** The model identifier string */
    model: string;

    /**
     * Generates a stream of text chunks based on a prompt.
     * @param prompt - The input prompt.
     * @param options - Generation options (tokens, temp, signal).
     */
    generateStream(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): AsyncGenerator<string, void, unknown>;
}

export class ProviderError extends Error {
    constructor(
        message: string,
        public provider: string,
        public code?: string,
        public retryable: boolean = true,
    ) {
        super(message);
        this.name = "ProviderError";
    }
}

/**
 * Common handler for mapping provider-specific errors to standardized ProviderError.
 */
function handleProviderError(provider: string, error: unknown): never {
    if (error instanceof ProviderError) throw error;

    const err = error as {
        status?: number;
        message?: string;
        code?: string | number;
    };
    let msg = (error instanceof Error ? error.message : err?.message) || String(error);
    if (!msg || msg === "undefined" || msg === "[object Object]") {
        msg = "Unknown error";
    }

    // REDACTION: Remove potential API keys and sensitive tokens
    // Delegated to centralized logger redaction
    msg = redact(msg) as string;

    let code = String(err?.code || "UNKNOWN");
    let retryable = true;

    const status = Number(err?.status);

    if (status === 429) {
        msg = "Rate limit exceeded";
        code = "RATE_LIMIT";
    } else if (status === 401 || status === 403) {
        msg = "Authentication failed";
        code = "AUTH_ERROR";
        retryable = false;
    } else if (status === 400) {
        msg = `Invalid request: ${msg}`;
        code = "INVALID_REQUEST";
        retryable = false;
    } else if (status >= 500) {
        msg = "Provider server error";
        code = "SERVER_ERROR";
    } else if (
        msg.toLowerCase().includes("timeout") ||
        msg.toLowerCase().includes("abort")
    ) {
        msg = "Request timeout or aborted";
        code = "TIMEOUT";
    } else if (
        msg.toLowerCase().includes("context_length_exceeded") ||
        msg.toLowerCase().includes("prompt is too long") ||
        msg.toLowerCase().includes("string too long") ||
        msg.toLowerCase().includes("tokens exceeds")
    ) {
        msg = "Context window overflow";
        code = "CONTEXT_OVERFLOW";
        retryable = false;
    } else if (
        status === 404 ||
        msg.toLowerCase().includes("model not found") ||
        msg.toLowerCase().includes("does not exist")
    ) {
        msg = "Model not found or not accessible";
        code = "MODEL_NOT_FOUND";
        retryable = false;
    }

    // Do NOT log the full error object if it might contain headers/keys
    logger.warn(`[AI] ${provider} Error (${code}): ${msg}`);
    throw new ProviderError(msg, provider, code, retryable);
}

/**
 * Common Timeout Helper.
 * @param providedSignal Optional signal from caller.
 * @param ms Timeout duration in milliseconds.
 */
function useTimeout(
    providedSignal?: AbortSignal,
    ms: number = DEFAULT_TIMEOUT,
): { signal: AbortSignal; cleanup: () => void } {
    if (providedSignal) return { signal: providedSignal, cleanup: () => { } };
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(id),
    };
}

/**
 * OpenAI Text Generation Adapter.
 * Uses the official OpenAI SDK with resilience patterns (CircuitBreaker + Retry).
 */
export class OpenAIGenerator implements GenerationAdapter {
    private client: OpenAI;
    public model: string;
    public usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    private breaker: CircuitBreaker;

    constructor(
        apiKey: string,
        model: string = env.openaiModel,
        baseUrl?: string,
    ) {
        this.client = new OpenAI({
            apiKey,
            baseURL: baseUrl,
            defaultHeaders: { "User-Agent": USER_AGENT },
        });
        this.model = model;
        this.breaker = new CircuitBreaker({
            name: `OpenAI-${model}`,
            failureThreshold: 3,
        });
    }

    async generate(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<string> {
        return withResilience(
            async () => {
                try {
                    const res = await this.client.chat.completions.create(
                        {
                            model: this.model,
                            messages: [
                                ...(options?.system ? [{ role: "system" as const, content: options.system }] : []),
                                { role: "user", content: prompt }
                            ],
                            max_tokens: options?.max_tokens || 4096,
                            temperature: options?.temperature ?? 0.7,
                        },
                        { timeout: DEFAULT_TIMEOUT, signal: options?.signal },
                    ); // signal overrides timeout in SDK
                    const content = res.choices[0]?.message?.content || "";
                    if (res.usage) {
                        this.usage = {
                            promptTokens: res.usage.prompt_tokens,
                            completionTokens: res.usage.completion_tokens,
                            totalTokens: res.usage.total_tokens,
                        };
                    }
                    return content;
                } catch (error) {
                    handleProviderError("openai", error);
                }
            },
            this.breaker,
            {
                retries: 3,
                shouldRetry: (e) => (e as ProviderError)?.retryable !== false,
                onRetry: (e, att) =>
                    logger.warn(`[AI] OpenAI retry ${att}/3:`, {
                        error: (e as Error).message,
                    }),
            },
        );
    }

    async generateJSON<T>(
        prompt: string,
        _schema?: Record<string, unknown>,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<T> {
        return withResilience(
            async () => {
                try {
                    const res = await this.client.chat.completions.create(
                        {
                            model: this.model,
                            messages: [
                                {
                                    role: "system",
                                    content:
                                        (options?.system ? options.system + "\n" : "") +
                                        "You are a helpful assistant that outputs JSON only.",
                                },
                                {
                                    role: "user",
                                    content:
                                        prompt +
                                        (_schema
                                            ? `\n\nFollow this JSON schema: ${JSON.stringify(_schema)}`
                                            : ""),
                                },
                            ],
                            response_format: { type: "json_object" },
                            temperature: options?.temperature ?? 0.1,
                            max_tokens: options?.max_tokens || 4096,
                        },
                        {
                            timeout: DEFAULT_TIMEOUT * 2,
                            signal: options?.signal,
                        },
                    );
                    const content = res.choices[0]?.message?.content || "{}";
                    if (res.usage) {
                        this.usage = {
                            promptTokens: res.usage.prompt_tokens,
                            completionTokens: res.usage.completion_tokens,
                            totalTokens: res.usage.total_tokens,
                        };
                    }
                    return JSON.parse(content) as T;
                } catch (e: unknown) {
                    if (e instanceof SyntaxError) {
                        throw new ProviderError(
                            "Invalid JSON response",
                            "openai",
                            "PARSE_ERROR",
                            false,
                        );
                    }
                    handleProviderError("openai", e);
                }
            },
            this.breaker,
            {
                retries: 3,
                shouldRetry: (e) => (e as ProviderError)?.retryable !== false,
                onRetry: (e, att) =>
                    logger.warn(`[AI] OpenAI JSON retry ${att}/3:`, {
                        error: (e as Error).message,
                    }),
            },
        );
    }

    async *generateStream(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): AsyncGenerator<string, void, unknown> {
        const { signal, cleanup } = useTimeout(options?.signal, DEFAULT_TIMEOUT);

        try {
            const stream = await this.client.chat.completions.create(
                {
                    model: this.model,
                    messages: [
                        ...(options?.system ? [{ role: "system" as const, content: options.system }] : []),
                        { role: "user", content: prompt }
                    ],
                    max_tokens: options?.max_tokens || 4096,
                    temperature: options?.temperature ?? 0.7,
                    stream: true,
                    stream_options: { include_usage: true },
                },
                { signal },
            );

            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || "";
                if (content) yield content;
                if (chunk.usage) {
                    this.usage = {
                        promptTokens: chunk.usage.prompt_tokens,
                        completionTokens: chunk.usage.completion_tokens,
                        totalTokens: chunk.usage.total_tokens,
                    };
                }
            }
        } catch (error) {
            handleProviderError("openai", error);
        } finally {
            cleanup();
        }
    }
}



/**
 * Google Gemini Text Generation Adapter.
 * Uses REST API via fetch for lightweight integration.
 * Securely handles API keys via headers.
 */
export class GeminiGenerator implements GenerationAdapter {
    public model: string;
    private key: string;
    private baseUrl: string;
    private apiVersion: string;
    public usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    private breaker: CircuitBreaker;

    constructor(
        apiKey: string,
        model: string = env.geminiModel,
        baseUrl?: string,
        apiVersion: string = env.geminiApiVersion,
    ) {
        this.key = apiKey;
        this.model = model;
        this.baseUrl = (baseUrl || env.geminiBaseUrl).replace(/\/$/, "");
        this.apiVersion = apiVersion;
        this.breaker = new CircuitBreaker({
            name: `Gemini-${model}`,
            failureThreshold: 3,
        });
    }

    /**
     * Internal helper to make the Fetch call.
     * @param prompt - Input text.
     * @param jsonMode - Force JSON MIME type.
     * @param options - Generation options.
     * @param schema - Optional JSON schema.
     */
    private async call(
        prompt: string,
        jsonMode: boolean,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
        },
        schema?: Record<string, unknown>,
    ): Promise<string> {
        const url = `${this.baseUrl}/${this.apiVersion}/models/${this.model}:generateContent`; // Key removed from URL
        const { signal, cleanup } = useTimeout(options?.signal, DEFAULT_TIMEOUT);

        try {
            const body: Record<string, unknown> = {
                contents: [
                    {
                        parts: [
                            {
                                text:
                                    prompt +
                                    (schema
                                        ? `\n\nFollow this JSON schema: ${JSON.stringify(schema)}`
                                        : ""),
                            },
                        ],
                    },
                ],
                generationConfig: {
                    temperature: options?.temperature ?? 0.7,
                    responseMimeType: jsonMode
                        ? "application/json"
                        : "text/plain",
                },
            };
            if (options?.max_tokens || !jsonMode) {
                (
                    body.generationConfig as Record<string, unknown>
                ).maxOutputTokens = options?.max_tokens || 4096;
            }

            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "x-goog-api-key": this.key, // Key moved to header
                },
                body: JSON.stringify(body),
                signal: signal,
            });

            if (!res.ok) {
                let errMsg = res.statusText;
                let status = res.status;
                try {
                    const errData = (await res.json()) as GeminiResponse;
                    if (errData.error) {
                        errMsg = errData.error.message;
                        status = typeof errData.error.code === 'number' ? errData.error.code : status;
                    }
                } catch (parseErr) {
                    logger.debug("[AI] Gemini error response parse failed", { error: parseErr });
                }

                handleProviderError("gemini", { status, message: errMsg });
            }

            const data = (await res.json()) as GeminiResponse;
            if (data.usageMetadata) {
                this.usage = {
                    promptTokens: data.usageMetadata.promptTokenCount,
                    completionTokens: data.usageMetadata.candidatesTokenCount,
                    totalTokens: data.usageMetadata.totalTokenCount,
                };
            }
            return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        } catch (error) {
            handleProviderError("gemini", error);
        } finally {
            cleanup();
        }
    }

    async generate(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<string> {
        return withResilience(
            () => {
                const finalPrompt = options?.system
                    ? `System: ${options.system}\n\nUser: ${prompt}`
                    : prompt;
                return this.call(finalPrompt, false, options);
            },
            this.breaker,
            {
                retries: 3,
                shouldRetry: (e) => (e as ProviderError)?.retryable !== false,
                onRetry: (e, att) =>
                    logger.warn(`[AI] Gemini retry ${att}/3:`, {
                        error: (e as Error).message,
                    }),
            },
        );
    }

    async generateJSON<T>(
        prompt: string,
        schema?: Record<string, unknown>,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<T> {
        return withResilience(
            async () => {
                try {
                    const finalPrompt = options?.system
                        ? `System: ${options.system}\n\nUser: ${prompt}`
                        : prompt;
                    const text = await this.call(
                        finalPrompt + "\nResponse must be valid JSON.",
                        true,
                        options,
                        schema,
                    );
                    return JSON.parse(text) as T;
                } catch (e: unknown) {
                    if (e instanceof SyntaxError) {
                        throw new ProviderError(
                            "Invalid JSON",
                            "gemini",
                            "PARSE_ERROR",
                            false,
                        );
                    }
                    throw e;
                }
            },
            this.breaker,
            {
                retries: 3,
                shouldRetry: (e) => (e as ProviderError)?.retryable !== false,
                onRetry: (e, att) =>
                    logger.warn(`[AI] Gemini JSON retry ${att}/3:`, {
                        error: (e as Error).message,
                    }),
            },
        );
    }

    async *generateStream(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): AsyncGenerator<string, void, unknown> {
        const url = `${this.baseUrl}/${this.apiVersion}/models/${this.model}:streamGenerateContent?alt=sse`;
        const { signal, cleanup } = useTimeout(options?.signal, DEFAULT_TIMEOUT);

        try {
            const finalPrompt = options?.system
                ? `System: ${options.system}\n\nUser: ${prompt}`
                : prompt;
            const body: Record<string, unknown> = {
                contents: [{ parts: [{ text: finalPrompt }] }],
                generationConfig: {
                    temperature: options?.temperature ?? 0.7,
                },
            };
            if (options?.max_tokens) {
                (body.generationConfig as Record<string, unknown>).maxOutputTokens = options.max_tokens;
            }

            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "x-goog-api-key": this.key,
                },
                body: JSON.stringify(body),
                signal,
            });

            if (!res.ok) {
                handleProviderError("gemini", { status: res.status, message: res.statusText });
            }

            if (!res.body) return;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });

                // Parse SSE format: data: { ... }
                const lines = chunk.split("\n");
                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        const jsonStr = line.slice(6);
                        if (jsonStr.trim() === "[DONE]") continue;
                        try {
                            const data = JSON.parse(jsonStr) as GeminiResponse;
                            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text) yield text;
                            if (data.usageMetadata) {
                                this.usage = {
                                    promptTokens: data.usageMetadata.promptTokenCount,
                                    completionTokens: data.usageMetadata.candidatesTokenCount,
                                    totalTokens: data.usageMetadata.totalTokenCount,
                                };
                            }
                        } catch (e) {
                            // Ignore parse errors for partial chunks
                        }
                    }
                }
            }

        } catch (error) {
            handleProviderError("gemini", error);
        } finally {
            cleanup();
        }
    }
}



/**
 * Ollama Local GenAI Adapter.
 * Supports local inference servers compatible with the Ollama API.
 */
export class OllamaGenerator implements GenerationAdapter {
    public model: string;
    private url: string;
    public usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    private breaker: CircuitBreaker;

    constructor(baseUrl: string, model: string = env.ollamaModel) {
        this.url = baseUrl.replace(/\/$/, "");
        this.model = model;
        this.breaker = new CircuitBreaker({
            name: `Ollama-${model}`,
            failureThreshold: 3,
        });
    }

    private async callOllama(
        endpoint: "/api/generate" | "/api/chat",
        body: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<OllamaResponse | OllamaChatResponse> {
        const res = await fetch(`${this.url}${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            body: JSON.stringify(body),
            signal: signal,
        });

        if (!res.ok) {
            let errMsg = res.statusText;
            let status = res.status;
            try {
                const errData = (await res.json()) as { error?: string };
                if (errData.error) {
                    errMsg = errData.error;
                }
            } catch (parseErr) {
                logger.debug("[AI] Ollama error response parse failed", { error: parseErr });
            }
            const retryable = res.status === 429 || res.status >= 500;
            throw new ProviderError(
                `Ollama Error ${status}: ${errMsg}`,
                "ollama",
                String(status),
                retryable,
            );
        }

        const data = await res.json() as OllamaResponse | OllamaChatResponse;

        // Normalize usage tracking if available (Ollama provides eval counts)
        const usageData = data as OllamaResponse;
        this.usage = {
            promptTokens: usageData.prompt_eval_count || 0,
            completionTokens: usageData.eval_count || 0,
            totalTokens: (usageData.prompt_eval_count || 0) + (usageData.eval_count || 0),
        };
        return data;
    }

    async generate(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<string> {
        return withResilience(
            async () => {
                const { signal, cleanup } = useTimeout(options?.signal, OLLAMA_TIMEOUT);

                try {
                    // Use /api/chat for better prompt handling if it looks like it has instructions
                    const useChat = prompt.includes("Instructions:") || prompt.includes("Context:");
                    if (useChat) {
                        const body: Record<string, unknown> = {
                            model: this.model,
                            messages: [
                                ...(options?.system ? [{ role: "system" as const, content: options.system }] : []),
                                { role: "user", content: prompt }
                            ],
                            stream: false,
                        };
                        if (options?.max_tokens)
                            body.options = { ...(body.options as object || {}), num_predict: options.max_tokens };
                        if (options?.temperature !== undefined)
                            body.options = { ...(body.options as object || {}), temperature: options.temperature };

                        const data = (await this.callOllama("/api/chat", body, signal)) as OllamaChatResponse;
                        return data.message.content;
                    } else {
                        const body: Record<string, unknown> = {
                            model: this.model,
                            prompt,
                            system: options?.system,
                            stream: false,
                        };
                        if (options?.max_tokens)
                            body.num_predict = options.max_tokens;
                        if (options?.temperature !== undefined)
                            body.temperature = options.temperature;

                        const data = (await this.callOllama("/api/generate", body, signal)) as OllamaResponse;
                        return data.response;
                    }
                } catch (error) {
                    handleProviderError("ollama", error);
                } finally {
                    cleanup();
                }
            },
            this.breaker,
            {
                retries: 3,
                shouldRetry: (e) => (e as ProviderError)?.retryable !== false,
                onRetry: (e, att) =>
                    logger.warn(`[AI] Ollama retry ${att}/3:`, {
                        error: (e as Error).message,
                    }),
            },
        );
    }

    async generateJSON<T>(
        prompt: string,
        schema?: Record<string, unknown>,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<T> {
        return withResilience(
            async () => {
                const { signal, cleanup } = useTimeout(options?.signal, OLLAMA_TIMEOUT);

                try {
                    const body: Record<string, unknown> = {
                        model: this.model,
                        prompt:
                            prompt +
                            (schema
                                ? `\n\nFollow this JSON schema: ${JSON.stringify(schema)}`
                                : ""),
                        system: options?.system
                            ? options.system + "\nYou are a helpful assistant that outputs JSON only."
                            : "You are a helpful assistant that outputs JSON only.",
                        format: "json",
                        stream: false,
                    };
                    if (options?.max_tokens)
                        body.num_predict = options.max_tokens;
                    if (options?.temperature !== undefined)
                        body.temperature = options.temperature;

                    const data = (await this.callOllama("/api/generate", body, signal)) as OllamaResponse;
                    return JSON.parse(data.response) as T;
                } catch (error) {
                    if (error instanceof SyntaxError) {
                        throw new ProviderError(
                            "Invalid JSON",
                            "ollama",
                            "PARSE_ERROR",
                            false,
                        );
                    }
                    handleProviderError("ollama", error);
                } finally {
                    cleanup();
                }
            },
            this.breaker,
            {
                retries: 3,
                shouldRetry: (e) => (e as ProviderError)?.retryable !== false,
                onRetry: (e, att) =>
                    logger.warn(`[AI] Ollama JSON retry ${att}/3:`, {
                        error: (e as Error).message,
                    }),
            },
        );
    }

    async *generateStream(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): AsyncGenerator<string, void, unknown> {
        const { signal, cleanup } = useTimeout(options?.signal, OLLAMA_TIMEOUT);

        try {
            const body: Record<string, unknown> = {
                model: this.model,
                prompt,
                system: options?.system,
                stream: true,
            };
            if (options?.max_tokens)
                body.num_predict = options.max_tokens;
            if (options?.temperature !== undefined)
                body.temperature = options.temperature;

            const res = await fetch(`${this.url}/api/generate`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                },
                body: JSON.stringify(body),
                signal,
            });

            if (!res.ok) {
                handleProviderError("ollama", { status: res.status, message: res.statusText });
            }

            if (!res.body) return;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split("\n");

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line) as OllamaResponse;
                        if (data.response) yield data.response;

                        // Capture usage if done
                        if (data.done) {
                            this.usage = {
                                promptTokens: data.prompt_eval_count || 0,
                                completionTokens: data.eval_count || 0,
                                totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
                            };
                            break;
                        }
                    } catch (e) {
                        // ignore partial JSON
                    }
                }
            }

        } catch (error) {
            handleProviderError("ollama", error);
        } finally {
            cleanup();
        }
    }
}

/**
 * Anthropic Claude Text Generation Adapter.
 * Uses the official Anthropic SDK.
 */
export class AnthropicGenerator implements GenerationAdapter {
    private client: Anthropic;
    public model: string;
    public usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    private breaker: CircuitBreaker;

    constructor(
        apiKey: string,
        model: string = env.anthropicModel,
        baseUrl?: string,
    ) {
        this.client = new Anthropic({
            apiKey,
            baseURL: baseUrl,
            defaultHeaders: { "User-Agent": USER_AGENT },
        });
        this.model = model;
        this.breaker = new CircuitBreaker({
            name: `Anthropic-${model}`,
            failureThreshold: 3,
        });
    }

    async generate(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<string> {
        return withResilience(
            async () => {
                const { signal, cleanup } = useTimeout(options?.signal, DEFAULT_TIMEOUT);

                try {
                    const res = await this.client.messages.create(
                        {
                            model: this.model,
                            max_tokens: options?.max_tokens || 4096,
                            system: options?.system,
                            messages: [{ role: "user", content: prompt }],
                            temperature: options?.temperature ?? 0.7,
                        },
                        { signal },
                    );
                    const content = (res.content[0] as { text: string }).text || "";
                    this.usage = {
                        promptTokens: res.usage.input_tokens,
                        completionTokens: res.usage.output_tokens,
                        totalTokens: res.usage.input_tokens + res.usage.output_tokens,
                    };
                    return content;
                } catch (error) {
                    handleProviderError("anthropic", error);
                } finally {
                    cleanup();
                }
            },
            this.breaker,
            {
                retries: 3,
                shouldRetry: (e) => (e as ProviderError)?.retryable !== false,
                onRetry: (e, att) =>
                    logger.warn(`[AI] Anthropic retry ${att}/3:`, {
                        error: (e as Error).message,
                    }),
            },
        );
    }

    async *generateStream(
        prompt: string,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): AsyncGenerator<string, void, unknown> {
        const { signal, cleanup } = useTimeout(options?.signal, DEFAULT_TIMEOUT);
        // Track local usage to accumulate
        let inputTokens = 0;
        let outputTokens = 0;

        try {
            const stream = await this.client.messages.create(
                {
                    model: this.model,
                    max_tokens: options?.max_tokens || 4096,
                    system: options?.system,
                    messages: [{ role: "user", content: prompt }],
                    temperature: options?.temperature ?? 0.7,
                    stream: true,
                },
                { signal },
            );

            for await (const chunk of stream) {
                if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
                    yield chunk.delta.text;
                }

                // Capture usage from events
                if (chunk.type === "message_start" && chunk.message.usage) {
                    inputTokens = chunk.message.usage.input_tokens || 0;
                }
                if (chunk.type === "message_delta" && chunk.usage) {
                    outputTokens = chunk.usage.output_tokens || 0;
                }
            }
            // Update final usage
            this.usage = {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
            };

        } catch (error) {
            handleProviderError("anthropic", error);
        } finally {
            cleanup();
        }
    }

    async generateJSON<T>(
        prompt: string,
        schema?: Record<string, unknown>,
        options?: {
            max_tokens?: number;
            temperature?: number;
            signal?: AbortSignal;
            system?: string;
        },
    ): Promise<T> {
        return withResilience(
            async () => {
                const { signal, cleanup } = useTimeout(options?.signal, DEFAULT_TIMEOUT);

                try {
                    const res = await this.client.messages.create(
                        {
                            model: this.model,
                            max_tokens: options?.max_tokens || 4096,
                            system: (options?.system ? options.system + "\n" : "") + "Output ONLY valid JSON.",
                            messages: [
                                {
                                    role: "user",
                                    content:
                                        prompt +
                                        (schema
                                            ? `\n\nFollow this JSON schema: ${JSON.stringify(schema)}`
                                            : ""),
                                },
                            ],
                            temperature: options?.temperature ?? 0.1,
                        },
                        { signal },
                    );
                    const content =
                        (res.content[0] as { text: string }).text || "{}";
                    this.usage = {
                        promptTokens: res.usage.input_tokens,
                        completionTokens: res.usage.output_tokens,
                        totalTokens: res.usage.input_tokens + res.usage.output_tokens,
                    };
                    return JSON.parse(content) as T;
                } catch (e: unknown) {
                    if (e instanceof SyntaxError) {
                        throw new ProviderError(
                            "Invalid JSON response",
                            "anthropic",
                            "PARSE_ERROR",
                            false,
                        );
                    }
                    handleProviderError("anthropic", e);
                } finally {
                    cleanup();
                }
            },
            this.breaker,
            {
                retries: 3,
                shouldRetry: (e) => (e as ProviderError)?.retryable !== false,
                onRetry: (e, att) =>
                    logger.warn(`[AI] Anthropic JSON retry ${att}/3:`, {
                        error: (e as Error).message,
                    }),
            },
        );
    }
}

// Simple singleton cache (system-wide)
import { normalizeUserId } from "../utils";
import { SimpleCache } from "../utils/cache";

let _generator: GenerationAdapter | null = null;
const _userGenerators = new SimpleCache<string, GenerationAdapter>({
    maxSize: 100,
});

/**
 * SaaS configuration structure for AI providers.
 */
interface SaaSConfig {
    key?: string;
    model?: string;
    baseUrl?: string;
    apiVersion?: string;
}

/**
 * Retrieves the best available generator for a given user context.
 * Prioritizes user-specific persisted config, then system env vars.
 */
const loadSaaSConfig = async (userId: string | null, type: string): Promise<SaaSConfig | null> => {
    // 1. User Specific Config
    if (userId) {
        const userCfg = await getPersistedConfig<SaaSConfig>(
            userId,
            type,
        );
        if (userCfg && (userCfg.key || userCfg.baseUrl)) return userCfg;
    }
    // 2. System Global Config (SaaS Default)
    const sysCfg = await getPersistedConfig<SaaSConfig>(null, type);
    if (sysCfg && (sysCfg.key || sysCfg.baseUrl)) return sysCfg;

    return null;
};

/**
 * Retrieves the best available generator for a given user context.
 *
 * Strategy (in order of priority):
 * 1. User-specific Persistent Config (DB)
 * 2. System-wide Persistent Config (DB)
 * 3. Environment Variables (Environment)
 * 4. Hardcoded Fallbacks (if any)
 *
 * @param userId Optional user context. If provided, checks user-specific overrides.
 */
export const get_generator = async (
    userId?: string | null,
): Promise<GenerationAdapter | null> => {
    const uid = normalizeUserId(userId);

    // Check user-specific cache
    if (uid) {
        const cached = _userGenerators.get(uid);
        if (cached) return cached;
    }
    // Note: We do NOT use global cache `_generator` anymore if we want strict SaaS isolation for "null" user?
    // Actually, `_generator` was "System Fallback". We can keep it for performance if we cache "System Config".
    if (uid === undefined && _generator) return _generator;

    let g: GenerationAdapter | null = null;
    let configSource = "ENV";

    // --- STRATEGY: CHECK SaaS CONFIGS FIRST ---

    // 1. OpenAI
    const oai = await loadSaaSConfig(uid || null, "openai");
    if (oai) {
        g = new OpenAIGenerator(
            oai.key || env.openaiKey || "",
            oai.model || env.openaiModel,
            oai.baseUrl || env.openaiBaseUrl,
        );
        configSource = uid ? "USER_DB" : "SYSTEM_DB";
    }

    // 2. Anthropic
    if (!g) {
        const ant = await loadSaaSConfig(uid || null, "anthropic");
        if (ant) {
            g = new AnthropicGenerator(
                ant.key || env.anthropicKey || "",
                ant.model || env.anthropicModel,
                ant.baseUrl || env.anthropicBaseUrl,
            );
            configSource = uid ? "USER_DB" : "SYSTEM_DB";
        }
    }

    // 3. Gemini
    if (!g) {
        const gem = await loadSaaSConfig(uid || null, "gemini");
        if (gem) {
            g = new GeminiGenerator(
                gem.key || env.geminiKey || "",
                gem.model || env.geminiModel,
                gem.baseUrl || env.geminiBaseUrl,
                gem.apiVersion || env.geminiApiVersion,
            );
            configSource = uid ? "USER_DB" : "SYSTEM_DB";
        }
    }

    // 4. Ollama (System/User Configured)
    if (!g) {
        const oll = await loadSaaSConfig(uid || null, "ollama");
        if (oll) {
            // Use env.ollamaModel as default if not in SaaS config
            g = new OllamaGenerator(
                oll.baseUrl || env.ollamaUrl || "http://localhost:11434",
                oll.model || env.ollamaModel,
            );
            configSource = uid ? "USER_DB" : "SYSTEM_DB";
        }
    }

    // --- FALLBACK: ENV VARS (BOOTSTRAP / LEGACY) ---
    // User requested "Dashboard Only", so we deprioritize Env Vars significantly.
    // They are used ONLY if SaaS Config returned nothing.

    if (!g) {
        // Explicit Local (Env)
        if (env.ollamaModel && env.ollamaModel !== "llama3") {
            // check against default if needed, or just use it
            g = new OllamaGenerator(
                env.ollamaUrl || "http://localhost:11434",
                env.ollamaModel,
            );
        }
        // Cloud Keys (Env)
        else if (env.openaiKey) {
            g = new OpenAIGenerator(
                env.openaiKey,
                env.openaiModel,
                env.openaiBaseUrl,
            );
        } else if (env.anthropicKey) {
            g = new AnthropicGenerator(
                env.anthropicKey,
                env.anthropicModel,
                env.anthropicBaseUrl,
            );
        } else if (env.geminiKey) {
            g = new GeminiGenerator(
                env.geminiKey,
                env.geminiModel,
                env.geminiBaseUrl,
                env.geminiApiVersion,
            );
        }
        // Implicit Local (Env Default) - Last Resort
        else if (env.ollamaUrl) {
            g = new OllamaGenerator(env.ollamaUrl, env.ollamaModel);
        }
    }

    if (g) {
        if (uid) _userGenerators.set(uid, g);
        else _generator = g;

        // Log only if it's a new initialization
        void configSource;
        // logger.debug(`[AI] Initialized Generator [${configSource}]: ${g.model}`);
    }

    return g;
};

/**
 * Invalidates the cached generator for a specific user or the system.
 * Use this when AI configurations (API keys, models) are updated.
 * 
 * @param userId - The user ID to flush. Pass null/undefined to flush system default.
 */
export const flush_generator = (userId?: string | null): void => {
    const uid = normalizeUserId(userId);
    if (uid) {
        _userGenerators.delete(uid);
    } else {
        _generator = null;
    }
};

/**
 * Clears all cached AI generators.
 */
export const flush_all_generators = (): void => {
    _userGenerators.clear();
    _generator = null;
};
