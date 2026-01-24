import { describe, expect, test, beforeEach } from "bun:test";
import { ContextManager } from "../../src/ai/contextManager";

describe("ContextManager", () => {
    let cm: ContextManager;

    beforeEach(() => {
        cm = new ContextManager();
    });

    test("counts tokens approximately", () => {
        // "Hello world" -> 2 words -> ~3-4 tokens
        const t1 = cm["countTokens"]("Hello world");
        expect(t1).toBeGreaterThan(0);

        // "This is a longer sentence to test token counting logic." 
        // 9 words -> ~12 tokens
        const t2 = cm["countTokens"]("This is a longer sentence to test token counting logic.");
        expect(t2).toBeGreaterThan(t1);
    });

    test("adds items correctly", () => {
        cm.add("user", "Hello", "normal");
        expect(cm.getTotalTokens()).toBeGreaterThan(0);
        expect(cm.getItems().length).toBe(1);
    });

    test("prunes based on recency", () => {
        cm.add("user", "Old message", "normal");
        cm.add("assistant", "New message", "normal");

        // Force very small budget to trigger pruning
        const pruned = cm.prune({ maxTokens: 5, strategy: "recency" });

        expect(pruned.length).toBeLessThan(2);
        // Should keep the newer one if it fits, or maybe just the partial?
        // Logic: sorts by time desc, keeps what fits. 
        // "New message" needs > 5 tokens probably.
        // Let's use larger messages to be sure about token counts vs budget
    });

    test("priority pruning keeps critical items", () => {
        // High priority items
        cm.add("system", "Critical instruction", "critical");
        cm.add("user", "Important user info", "high");

        // Low priority noise (make them huge to ensure they are candidates for pruning)
        cm.add("user", "Junk 1 ".repeat(10), "low");
        cm.add("user", "Junk 2 ".repeat(10), "low");

        // Set budget to comfortably fit high prio items but exclude junk
        // Critical (~3) + Important (~4) = ~7. Set budget to 15.
        // Junk is ~30 tokens each. 
        const pruned = cm.prune({ maxTokens: 20, strategy: "priority", preserveSystem: false });

        const content = pruned.map(i => i.content).join(" ");
        expect(content).toContain("Critical instruction");
        expect(content).toContain("Important user info");
        expect(content).not.toContain("Junk");
    });

    test("preserves system prompt by default", () => {
        cm.add("system", "You are a helpful assistant.");
        for (let i = 0; i < 10; i++) {
            cm.add("user", `Message ${i}`, "normal");
        }

        // Small budget
        const pruned = cm.prune({ maxTokens: 20 });

        expect(pruned.find(i => i.role === "system")).toBeDefined();
        // Should have kept system + maybe 1 recent msg
    });

    test("hybrid strategy balances priority and recency", () => {
        // Old High Priority
        const t1 = Date.now();
        cm.add("user", "Old Important", "high");
        // Hack to simulate time passing if needed, but array order implies added order?
        // ContextManager uses Date.now() on add.
        // We can't easily mock Date.now() here without a sleep or robust mock.
        // But we add sequentially.

        cm.add("user", "New Low Priority", "low");
        cm.add("user", "New Normal", "normal");

        // Hybrid: Sorts by Priority DESC, then Time DESC
        // "Old Important" (High) > "New Normal" (Normal) > "New Low Priority" (Low)

        const pruned = cm.prune({ maxTokens: 100, strategy: "hybrid" });
        // Should have same order in result as created (chronological) 
        // checking equality of input vs output items
        expect(pruned.length).toBe(3);

        // Now strict budget
        const budget = cm.getItems().find(i => i.content === "Old Important")!.tokens! + 2;
        const strict = cm.prune({ maxTokens: budget, strategy: "hybrid" });

        expect(strict.length).toBe(1);
        expect(strict[0].content).toBe("Old Important");
    });
});
