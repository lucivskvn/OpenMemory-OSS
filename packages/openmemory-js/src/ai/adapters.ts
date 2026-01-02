import { embed, getEmbeddingProvider, getEmbeddingInfo } from "../memory/embed";

export { embed, getEmbeddingProvider, getEmbeddingInfo };

/**
 * Interface for LLM Text Generation Adapters
 * Prepared for future integration of generative reflection/summarization.
 */
export interface GenerationAdapter {
    generate(prompt: string, options?: { max_tokens?: number; temperature?: number }): Promise<string>;
    generateJSON<T>(prompt: string, schema: Record<string, any>): Promise<T>;
}

// Placeholder for future default generator
export const get_generator = (): GenerationAdapter | null => {
    // Current system relies on deterministic logic.
    // Future expansion: Return OpenAI/Gemini/Ollama adapter here.
    return null;
};
