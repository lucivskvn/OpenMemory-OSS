import { describe, test, expect, spyOn } from "bun:test";
import { BaseSource, RateLimiter, SourceItem, SourceContent } from "../../src/sources/base";

// Mock Concrete Implementation
class MockSource extends BaseSource {
    override name = "mock";

    async _connect(creds: any): Promise<boolean> {
        return creds.token === "valid";
    }

    async _listItems(filters: any): Promise<SourceItem[]> {
        return [
            { id: "1", name: "item1", type: "file" }
        ];
    }

    async _fetchItem(itemId: string): Promise<SourceContent> {
        return {
            id: itemId,
            name: "item1",
            type: "text",
            text: "content",
            data: "content",
            metadata: {}
        };
    }
}

describe("Connector Primitives", () => {

    test("RateLimiter: Should throttle requests", async () => {
        const limiter = new RateLimiter(5); // 5 req/sec
        const start = Date.now();

        // Consume 6 tokens (burst) check delay
        // Actually, initial state is full tokens.
        // It should allow 5 immediately.

        for (let i = 0; i < 5; i++) {
            await limiter.acquire();
        }

        // 6th should block slightly
        await limiter.acquire();
        const diff = Date.now() - start;

        // 1 token replenishes in 200ms
        // Expect at least ~180ms delay if it worked (allowing for some drift)
        expect(diff).toBeGreaterThan(100);
    });

    test("BaseSource: Connection flow", async () => {
        const src = new MockSource();
        expect(src.connected).toBe(false);

        const res = await src.connect({ token: "valid" });
        expect(res).toBe(true);
        expect(src.connected).toBe(true);

        try {
            await src.connect({ token: "invalid" });
        } catch (e) {
            // expected
        }
    });

    test("BaseSource: Ingestion Flow", async () => {
        // Mock import
        const src = new MockSource();
        await src.connect({ token: "valid" });

        // We can't easily auto-mock dynamic imports in bun test without modules mocking support or dependency injection.
        // But we can check listItems behavior at least.
        const items = await src.listItems();
        expect(items.length).toBe(1);
        expect(items[0].name).toBe("item1");
    });
});
