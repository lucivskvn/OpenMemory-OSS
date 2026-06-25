
import { Memory } from 'openmemory-js';

// ==================================================================================
// CONVERSATION MANAGER
// ==================================================================================
// A robust manager for handling infinite context windows in chat applications.
//
// Features:
// - Session Management
// - Automatic Summarization (Simulation)
// - Relevant Context Injection
// ==================================================================================

interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
}

export class ConversationManager {
    private mem: Memory;
    private userId: string;

    constructor(userId: string) {
        this.mem = new Memory();
        this.userId = userId;
    }

    /**
     * Store a message and optionally summarize if the session is getting long.
     */
    async addMessage(role: 'user' | 'assistant', content: string) {
        await this.mem.add(content, {
            user_id: this.userId,
            metadata: {
                role: role,
                timestamp: Date.now(),
                type: 'chat_message'
            },
            tags: ['chat', role]
        });

        // In a real app, you might check token count here.
        // If > 4000 tokens, trigger a summarization task.
        // For this example, we just log.
        // console.log(`[Manager] Stored ${role} message.`);
    }

    /**
     * Retrieve the "Infinite Context" for the LLM.
     * This combines:
     * 1. The last N messages (Short Term Memory)
     * 2. Semantically relevant past messages (Long Term Memory)
     * 3. Relevant Facts/Summaries
     */
        async getContext(currentQuery: string, historyWindow: number = 5): Promise<string> {
        const relevantMemories = await this.mem.search(currentQuery, {
            user_id: this.userId,
            limit: 5,
            minSalience: 0.5 // Only high relevance
        });

        const contextBlocks: string[] = ["--- RELEVANT PAST MEMORIES ---"];

        if (relevantMemories.length === 0) {
            contextBlocks.push("(No relevant past memories found)");
            return contextBlocks.join("\n");
        }

        console.log(`[Manager] Found ${relevantMemories.length} relevant memories for context.`);
                for (const mem of relevantMemories) {
            // Fix: Check if mem.metadata exists, no fallback empty object, provide clear path
            if (mem.metadata?.timestamp) {
                const date = new Date(mem.metadata.timestamp as number).toISOString();
                contextBlocks.push(`[${date}] ${mem.content}`);
            } else {
                contextBlocks.push(`[Unknown Time] ${mem.content}`);
            }
        }

        return contextBlocks.join("\n");
    }

    /**
     * Persist a summary of a completed conversation segment.
     */
    async summarizeSegment(conversationText: string) {
        // This would normally call an LLM to summarize `conversationText`.
        // We simulate the output.
        const summary = `Generated Summary: User discussed ${conversationText.slice(0, 20)}...`;

        await this.mem.add(summary, {
            user_id: this.userId,
            metadata: { type: 'summary' },
            tags: ['summary', 'long_term']
        });
        console.log("[Manager] Conversation segment summarized and stored.");
    }
}

// ==================================================================================
// USAGE DEMO
// ==================================================================================

async function runDemo() {
    console.log("Initializing Conversation Manager...");
    const mgr = new ConversationManager("user_architect_01");

    // 1. Simulate an old conversation about architecture
    console.log("-> Simulating past conversations...");
    await mgr.addMessage("user", "We need to use microservices for the payment gateway.");
    await mgr.addMessage("assistant", "Agreed. I suggest using gRPC for inter-service comms.");
    await mgr.summarizeSegment("Payment gateway microservices using gRPC.");

    // 2. New conversation days later
    console.log("\n-> New Session Started.");
    const userQuery = "What protocol did we decide on for payments?";
    console.log(`User asks: "${userQuery}"`);

    // 3. Build Context
    console.log("-> Building Infinite Context...");
    const context = await mgr.getContext(userQuery);

    console.log("\n[LLM PROMPT CONTEXT]");
    console.log(context);
    console.log("--------------------");

    if (context.includes("gRPC")) {
        console.log("SUCCESS: Context contains the retrieved memory about gRPC.");
    } else {
        console.log("WARNING: Semantic search might need tuning/more data.");
    }
}

runDemo().catch(console.error);
