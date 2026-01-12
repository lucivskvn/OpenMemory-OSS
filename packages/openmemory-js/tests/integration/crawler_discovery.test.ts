import { describe, expect, it, mock } from "bun:test";
import { WebCrawlerSource } from "../../src/sources/web_crawler";

describe("Phase 111: Crawler Discovery", () => {
    it("should find links inside nav and footer during listing", async () => {
        const startUrl = "https://example.com";
        
        // Mock fetch to return a page with links in nav and content
        const mockFetch = mock((url: string) => {
            if (url === "https://example.com") {
                return Promise.resolve(new Response(`
                    <html>
                        <body>
                            <nav>
                                <a href="/nav-link">Nav Link</a>
                            </nav>
                            <main>
                                <a href="/content-link">Content Link</a>
                            </main>
                            <footer>
                                <a href="/footer-link">Footer Link</a>
                            </footer>
                        </body>
                    </html>
                `, { headers: { "content-type": "text/html" } }));
            }
            return Promise.resolve(new Response("<html><body>Content</body></html>", { headers: { "content-type": "text/html" } }));
        });

        globalThis.fetch = mockFetch as any;

        const source = new WebCrawlerSource("test-user", { maxPages: 5, maxDepth: 1 });
        const items = await source._listItems({ startUrl, followLinks: true });

        // Should have found links from nav, main, and footer
        const urls = items.map(i => i.url);
        expect(urls).toContain("https://example.com/nav-link");
        expect(urls).toContain("https://example.com/content-link");
        expect(urls).toContain("https://example.com/footer-link");
    });
});
