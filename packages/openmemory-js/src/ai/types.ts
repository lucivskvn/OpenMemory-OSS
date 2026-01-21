/**
 * @file types.ts
 * @description Shared type definitions for AI adapters and tools.
 */

export interface GeminiCandidate {
    content: {
        parts: { text: string }[];
    };
    finishReason?: string;
}

export interface GeminiResponse {
    candidates?: GeminiCandidate[];
    usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
    };
    error?: {
        code: number;
        message: string;
        status: string;
    };
}

export interface OllamaResponse {
    model: string;
    created_at: string;
    response: string;
    done: boolean;
    context?: number[];
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
}

export interface OllamaChatResponse {
    model: string;
    created_at: string;
    message: {
        role: "system" | "user" | "assistant";
        content: string;
    };
    done: boolean;
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
}
