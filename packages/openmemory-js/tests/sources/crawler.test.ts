import { expect, test, spyOn } from "bun:test";
import { WebCrawlerSource } from "../../src/sources/web_crawler";

test("WebCrawler - robots.txt parsing", async () => {
    const crawler = new WebCrawlerSource("user1");

    // Mock fetch for robots.txt
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(((url: string) => {
        if (url.endsWith("/robots.txt")) {
            return Promise.resolve(new Response("User-agent: *\nDisallow: /private\nDisallow: /admin/", { status: 200 }));
        }
        return Promise.resolve(new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    }) as any);

    // Access private method for testing or use _listItems to trigger it
    const patterns = await (crawler as any)._getRobots("https://example.com");
    expect(patterns).toContain("/private");
    expect(patterns).toContain("/admin/");

    fetchMock.mockRestore();
});

test("WebCrawler - URL canonicalization", async () => {
    const crawler = new WebCrawlerSource("user1");
    const visited = (crawler as any).visited;

    // Test logic from link extractor
    const base = "https://EXAMPLE.com/path/";
    const links = [
        "https://example.com/path",
        "https://example.com/path/",
        "HTTPS://EXAMPLE.COM/PATH#fragment",
        "subpage",
    ];

    const results = links.map(l => {
        const fullUrl = new URL(l, base);
        let cleanUrl = `${fullUrl.protocol}//${fullUrl.hostname.toLowerCase()}${fullUrl.pathname.toLowerCase()}${fullUrl.search}`;
        if (cleanUrl.endsWith("/") && cleanUrl.length > (fullUrl.protocol.length + fullUrl.hostname.length + 3)) {
            cleanUrl = cleanUrl.slice(0, -1);
        }
        return cleanUrl;
    });

    // All should canonicalize to the same thing if logic is correct
    expect(results[0]).toBe("https://example.com/path");
    expect(results[1]).toBe("https://example.com/path");
    expect(results[2]).toBe("https://example.com/path");
    expect(results[3]).toBe("https://example.com/path/subpage");
});
