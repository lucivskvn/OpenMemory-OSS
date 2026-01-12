
import { MemoryClient } from 'openmemory-js';

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
    private client: MemoryClient;
    private userId: string;

    constructor(userId: string) {
        // Assumes OpenMemory server is running at default localhost:8080
        this.client = new MemoryClient({ baseUrl: 'http://localhost:8080' });
        this.userId = userId;
    }

    /**
     * Store a message and optionally summarize if the session is getting long.
     */
    async addMessagesBatch(messages: { role: 'user' | 'assistant', content: string }[]) {
        const batch = messages.map(msg => ({
            content: msg.content,
            metadata: {
                role: msg.role,
                timestamp: Date.now(),
                type: 'chat_message'
            },
            tags: ['chat', msg.role]
        }));

        const results = await this.client.addBatch(batch);
        console.log(`[Manager] Batch stored ${results.length} messages.`);
    }

    /**
     * Retrieve the "Infinite Context" for the LLM.
     * This combines:
     * 1. The last N messages (Short Term Memory)
     * 2. Semantically relevant past messages (Long Term Memory)
     * 3. Relevant Facts/Summaries
     */
    async getContext(currentQuery: string, historyWindow: number = 5): Promise<string> {
        // 1. Fetch recent history (using search or a dedicated history endpoint if avail)
        // Since Memory.search is semantic, we might not get *ordered* history easily without ID tracking
        // But let's assume valid semantic search is what we want for *context*.

        // Ideally, we'd have a `mem.history(userId)` method. 
        // Let's use search for "relevant past" and assume the app maintains local state for immediate history
        // OR we use semantic search to find *related* past conversations.

        const relevantMemories = await this.client.search(currentQuery, {
            userId: this.userId,
            limit: 5,
            minSalience: 0.5 // Only high relevance
        });

        const contextBlocks: string[] = [];

        contextBlocks.push("--- RELEVANT PAST MEMORIES ---");
        if (relevantMemories.length === 0) {
            contextBlocks.push("(No relevant past memories found)");
        } else {
            console.log(`[Manager] Found ${relevantMemories.length} relevant memories for context.`);
            for (const mem of relevantMemories) {
                // Ensure metadata is treated as a Record if possible, though SDK returns generic type
                const meta = (mem.metadata || {}) as Record<string, any>;
                const date = meta.timestamp ? new Date(Number(meta.timestamp)).toISOString() : 'Unknown Time';
                contextBlocks.push(`[${date}] ${mem.content}`);
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

        await this.client.add(summary, {
            userId: this.userId,
            metadata: { type: 'summary' },
            tags: ['summary', 'long_term']
        });
        console.log("[Manager] Conversation segment summarized and stored.");
    }

    /**
     * Demo new System Timeline capability
     */
    async showTimelineStats() {
        console.log("\n-> Fetching System Timeline Stats...");
        const timeline = await this.client.getSystemTimeline(24);
        console.log(`[Manager] Timeline has ${timeline.length} time buckets active in last 24h.`);
        if (timeline.length > 0) {
            console.log("Sample Bucket:", JSON.stringify(timeline[0], null, 2));
        }
    }
}

// ==================================================================================
// USAGE DEMO
// ==================================================================================

async function runDemo() {
    console.log("Initializing Conversation Manager...");
    console.log("NOTE: Ensure OpenMemory server is running on http://localhost:8080");
    const mgr = new ConversationManager("user_architect_01");

    try {
        // 1. Simulate an old conversation about architecture using BATCH add
        console.log("-> Simulating past conversations (Batch Mode)...");
        await mgr.addMessagesBatch([
            { role: "user", content: "We need to use microservices for the payment gateway." },
            { role: "assistant", content: "Agreed. I suggest using gRPC for inter-service comms." }
        ]);
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

        // 4. Show new Timeline feature
        await mgr.showTimelineStats();

    } catch (e) {
        console.error("Demo failed (Is the server running?):", e);
    }
}

runDemo().catch(console.error);
