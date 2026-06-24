import { Memory } from '../../../packages/openmemory-js/src/core/memory';
import crypto from 'crypto';
import Redis from 'ioredis';
import { env } from '../../../packages/openmemory-js/src/core/config';

// ==================================================================================
// SEMANTIC CACHING PATTERN
// ==================================================================================
// Using OpenMemory as a semantic cache for expensive LLM calls.
// Instead of exact string matching (Redis), we use semantic similarity.
// strong similarity (>0.95) = Cache Hit.
// ==================================================================================

class SemanticCache {
    private mem: Memory;
    private userId: string = "system_semantic_cache";
    private readonly valkey: Redis;

    constructor() {
        this.mem = new Memory();
        // Use maxRetriesPerRequest: null to not buffer commands infinitely, keeping silent failures quick
        this.valkey = new Redis(env.valkey_port, env.valkey_host, { maxRetriesPerRequest: 1, showFriendlyErrorStack: true });
        // Log valkey errors to avoid silencing critical offline states but prevent crashes
        this.valkey.on('error', (err) => {
            console.debug('[Valkey Offline/Error]', err.message);
        });
    }

    private mockLLMCall(prompt: string): string {
        return `[LLM GENERATED] Response to: "${prompt}" (Computed at ${Date.now()})`;
    }

    async generate(prompt: string, userId: string = this.userId): Promise<string> {
        console.log(`\nInput: "${prompt}"`);

        // Create SHA-256 hash of the prompt for Tier 1 exactly match lookup
        const hash = crypto.createHash('sha256').update(prompt).digest('hex');
        const tier1Key = `cache:${userId}:${hash}`;

        try {
            // Tier 1: Exact match lookup in Valkey
            const tier1Hit = await this.valkey.get(tier1Key);
            if (tier1Hit) {
                console.log(` ⚡ Tier 1 Cache HIT (Valkey Exact Match)`);
                return tier1Hit;
            }
        } catch (error: any) {
            console.warn(`[Tier 1 Valkey Error] Gracefully falling back to Tier 2:`, error.message);
        }

        // Tier 2: Semantic search fallback using OpenMemory
        // We store content as `PROMPT: <prompt> | RESPONSE: <response>`
        // So we search for the prompt part.
        const hits = await this.mem.search(`PROMPT: ${prompt}`, {
            user_id: userId,
            limit: 1
        });

        // Check similarity threshold
        // Note: Real OpenMemory score is cosine similarity (0-1) or distance.
        // Assuming the SDK returns a 'score' field.
        const best = hits[0];
        if (best && best.score > 0.95) {
            // Parse response from stored format and ensure expected parts exist
            const parts = best.content.split("| RESPONSE:");
            if (parts.length >= 2) {
                console.log(` ✅ Tier 2 Cache HIT (Score: ${best.score.toFixed(4)})`);
                const cachedContent = parts[1].trim();

                // Backfill into Tier 1 Valkey cache with 24h TTL (86400 seconds)
                try {
                    await this.valkey.setex(tier1Key, 86400, cachedContent);
                } catch (error: any) {
                    console.warn(`[Tier 1 Valkey Backfill Error]:`, error.message);
                }

                return cachedContent;
            } else {
                console.warn(`[Tier 2 OpenMemory Error] Malformed cache entry format: ${best.content}. Falling back to miss.`);
            }
        }

        console.log(` ❌ Cache MISS. Calling LLM...`);
        const response = this.mockLLMCall(prompt);

        // Store new pair in Tier 2
        try {
            await this.mem.add(`PROMPT: ${prompt} | RESPONSE: ${response}`, {
                user_id: userId,
                metadata: { type: 'cache_entry' }
            });
        } catch (error: any) {
            console.warn(`[Tier 2 OpenMemory Store Error]:`, error.message);
        }

        // Backfill new generation into Tier 1 Valkey cache with 24h TTL (86400 seconds)
        try {
            await this.valkey.setex(tier1Key, 86400, response);
        } catch (error: any) {
            console.warn(`[Tier 1 Valkey Backfill Error]:`, error.message);
        }

        return response;
    }
}

async function main() {
    const cache = new SemanticCache();

    // First call
    await cache.generate("Explain black holes concisely");

    // Exact repeat
    await cache.generate("Explain black holes concisely");

    // Semantic repeat (different wording, same meaning)
    // Should hit if embedding model is good
    await cache.generate("Give me a short explanation of black holes");

    // Close valkey connection to exit process properly
    process.exit(0);
}

main().catch(console.error);
