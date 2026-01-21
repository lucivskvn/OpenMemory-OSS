
import { OpenAIGenerator, GeminiGenerator, OllamaGenerator, AnthropicGenerator } from "../src/ai/adapters";
import { env } from "../src/core/cfg";

const PROMPT = "Write a haiku about code.";

async function testStream(name: string, generator: any) {
    if (!generator) {
        console.log(`[SKIP] ${name} not configured.`);
        return;
    }
    console.log(`\n--- Testing ${name} Streaming ---`);
    try {
        const stream = generator.generateStream(PROMPT);
        let text = "";
        for await (const chunk of stream) {
            process.stdout.write(chunk);
            text += chunk;
        }
        console.log("\n[DONE]");
        if (text.length < 5) throw new Error("Output too short");
    } catch (e) {
        console.error(`\n[FAIL] ${name}:`, e);
    }
}

async function main() {
    console.log("Starting Streaming Verification...");

    const openai = env.openaiKey ? new OpenAIGenerator(env.openaiKey) : null;
    await testStream("OpenAI", openai);

    const anthropic = env.anthropicKey ? new AnthropicGenerator(env.anthropicKey) : null;
    await testStream("Anthropic", anthropic);

    const gemini = env.geminiKey ? new GeminiGenerator(env.geminiKey) : null;
    await testStream("Gemini", gemini);

    const ollama = new OllamaGenerator(env.ollamaUrl || "http://localhost:11434");
    await testStream("Ollama", ollama);
}

main();
