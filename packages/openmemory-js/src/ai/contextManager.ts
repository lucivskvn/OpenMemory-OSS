import { env } from "../core/cfg";
import { AppError } from "../server/errors";
import { normalizeUserId } from "../utils";
/**
 * @file contextManager.ts
 * @description Token-aware context window management and pruning logic.
 * @audited 2026-01-19
 */
import { logger } from "../utils/logger";
import { extractEssence, tokenize } from "../utils/text";

/**
 * Represents a piece of context that can be managed, pruned, or prioritized.
 */
export interface ContextItem {
    id: string;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    priority: "critical" | "high" | "normal" | "low";
    tokens?: number;
    metadata?: Record<string, unknown>;
    createdAt: number;
}

export interface ContextPruningOptions {
    maxTokens: number;
    preserveSystem?: boolean;
    strategy?: "recency" | "priority" | "hybrid";
}

/**
 * Manages the context window for AI agents, ensuring high-priority information
 * is retained while staying within token limits.
 *
 * Implements "Priority-Aware Pruning" to solve the sustainability gap.
 */
export class ContextManager {
    private items: ContextItem[] = [];
    private defaultUserId?: string | null;

    constructor(defaultUserId?: string | null) {
        this.defaultUserId = normalizeUserId(defaultUserId);
    }

    /**
     * Approximate token count using a simple heuristic (words * 1.3).
     * Faster than full tokenizer and sufficient for window management.
     */
    private countTokens(text: string): number {
        if (!text) return 0;
        // Use existing tokenizer from utils/text
        const tokens = tokenize(text);
        // Average 0.75 words per token -> 1.33 tokens per word + punctuation overhead
        // Simple heuristic: length / 4 is common, but word-based is safer for code/mixed content
        return Math.ceil(tokens.length * 1.3);
    }

    /**
     * Add an item to the context.
     */
    add(
        role: ContextItem["role"],
        content: string,
        priority: ContextItem["priority"] = "normal",
        metadata: Record<string, unknown> = {},
    ): ContextItem {
        const item: ContextItem = {
            id: crypto.randomUUID(),
            role,
            content,
            priority,
            tokens: this.countTokens(content),
            metadata,
            createdAt: Date.now(),
        };
        this.items.push(item);
        return item;
    }

    /**
     * Add multiple items at once.
     */
    addBatch(items: Omit<ContextItem, "id" | "tokens" | "createdAt">[]) {
        items.forEach((i) => this.add(i.role, i.content, i.priority, i.metadata));
    }

    /**
     * Prune context to fit within the specified token limit.
     */
    prune(options: ContextPruningOptions): ContextItem[] {
        const { maxTokens, preserveSystem = true, strategy = "hybrid" } = options;
        let currentTokens = this.getTotalTokens();

        if (currentTokens <= maxTokens) {
            return [...this.items];
        }

        // Sort items based on strategy
        // We want to keep items at the END of the list (sorted ascending by "evictability")
        let candidates = [...this.items];

        if (preserveSystem) {
            // Keep system prompts, remove them from eviction pool
            const systemItems = candidates.filter(i => i.role === "system");
            const otherItems = candidates.filter(i => i.role !== "system");

            // Recalculate usage for just the others
            const systemTokens = systemItems.reduce((sum, i) => sum + (i.tokens || 0), 0);
            const remainingBudget = Math.max(0, maxTokens - systemTokens);

            // If system alone exceeds budget, we have a problem, but we return system items at minimum
            if (systemTokens >= maxTokens) {
                logger.warn("[ContextManager] System prompt exceeds token budget!");
                return systemItems;
            }

            candidates = otherItems;
            currentTokens = candidates.reduce((sum, i) => sum + (i.tokens || 0), 0);

            // If we fit now, merge and return (sorted by time)
            if (currentTokens <= remainingBudget) {
                return [...systemItems, ...candidates].sort((a, b) => a.createdAt - b.createdAt);
            }

            // Adjust maxTokens for the pruning logic below
            // We prune 'candidates' to fit 'remainingBudget'
            return [
                ...systemItems,
                ...this.pruneList(candidates, remainingBudget, strategy)
            ].sort((a, b) => a.createdAt - b.createdAt);
        }

        return this.pruneList(candidates, maxTokens, strategy).sort((a, b) => a.createdAt - b.createdAt);
    }

    private pruneList(items: ContextItem[], budget: number, strategy: string): ContextItem[] {
        let currentUsage = items.reduce((sum, i) => sum + (i.tokens || 0), 0);
        const kept: ContextItem[] = [];

        // Clone and sort descending by value (keep high value)
        // Recency: Keep newest (sort by createdAt desc)
        // Priority: Keep highest priority, then newest
        const sorted = [...items].sort((a, b) => {
            if (strategy === "priority" || strategy === "hybrid") {
                const pMap = { critical: 4, high: 3, normal: 2, low: 1 };
                const pDiff = pMap[b.priority] - pMap[a.priority];
                if (pDiff !== 0) return pDiff;

                // Hybrid: within same priority, prefer recent
                return b.createdAt - a.createdAt;
            }
            // Recency only
            return b.createdAt - a.createdAt;
        });

        // Fill bucket
        let used = 0;
        for (const item of sorted) {
            const t = item.tokens || 0;
            if (used + t <= budget) {
                kept.push(item);
                used += t;
            } else {
                // Try to summarize? For now, just drop or maybe implement "soft" drop (essence)
                // This is where "Sustainability" comes in - don't just drop, maybe compress?
                if (item.content.length > 200 && strategy === "hybrid") {
                    // Attempt aggressive compression using utils/text
                    const compressed = extractEssence(item.content, Math.floor(item.content.length * 0.4));
                    const compTokens = this.countTokens(compressed);
                    if (used + compTokens <= budget) {
                        kept.push({
                            ...item,
                            content: `[Summary]: ${compressed}`,
                            tokens: compTokens
                        });
                        used += compTokens;
                    }
                }
            }
        }

        return kept;
    }

    getTotalTokens(): number {
        return this.items.reduce((sum, i) => sum + (i.tokens || 0), 0);
    }

    getItems(): ContextItem[] {
        return [...this.items];
    }

    clear() {
        this.items = [];
    }
}
