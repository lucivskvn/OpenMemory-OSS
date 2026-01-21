import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { WebCrawlerSource } from "../../src/sources/web_crawler";
import { getUniqueDbPath, cleanupIfSuccess, forceConfigReinit } from "../test_utils";
import { waitForDb } from "../../src/core/db";

const TEST_DB = getUniqueDbPath("crawler_discovery");

describe("Phase 111: Crawler Discovery", () => {
    beforeEach(async () => {
        Bun.env.OM_DB_PATH = TEST_DB;
        await forceConfigReinit();
        await waitForDb();
    });

    afterEach(async () => {
        await cleanupIfSuccess(TEST_DB);
        mock.restore();
    });

    it("should find links inside nav and footer during listing", async () => {
        const startUrl = "https://example.com";

        // Mock fetch to return a page with links in nav and content
        const mockFetch = mock((url: string | Request, init?: RequestInit) => {
            const urlStr = url.toString();
            // Check for Host header if present (handling different header formats)
            let hostHeader = "";
            if (init && init.headers) {
                if (init.headers instanceof Headers) {
                    hostHeader = init.headers.get("Host") || "";
                } else if (Array.isArray(init.headers)) {
                    const h = init.headers.find(p => p[0].toLowerCase() === "host");
                    hostHeader = h ? h[1] : "";
                } else {
                    // record
                    const h = (init.headers as Record<string, string>)["Host"] || (init.headers as Record<string, string>)["host"];
                    hostHeader = h || "";
                }
            }

            if (urlStr === "https://example.com" || urlStr === "https://example.com/" || hostHeader === "example.com") {
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
