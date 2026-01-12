import { describe, expect, it } from "bun:test";
import { extractHTML } from "../../src/ops/extract";
import { ingestDocument } from "../../src/ops/ingest";

describe("Phase 111: Ingestion Integrity", () => {
    it("should extract cleaner markdown from HTML", async () => {
        const html = `
            <html>
                <body>
                    <header><h1>My Site</h1><nav><ul><li>Home</li></ul></nav></header>
                    <main>
                        <article>
                            <h1>Main Title</h1>
                            <p>This is the actual content.</p>
                            <aside>Sidebar stuff</aside>
                        </article>
                    </main>
                    <footer>Copyright 2026</footer>
                </body>
            </html>
        `;

        const result = await extractHTML(html);
        
        // Should contain title and content
        expect(result.text).toContain("Main Title");
        expect(result.text).toContain("This is the actual content.");
        
        // Should NOT contain nav, header, footer, or aside
        expect(result.text).not.toContain("Home");
        expect(result.text).not.toContain("My Site");
        expect(result.text).not.toContain("Copyright 2026");
        expect(result.text).not.toContain("Sidebar stuff");
    });

    it("should handle nested main content correctly", async () => {
        const html = `
            <div id="wrapper">
                <nav>Menu</nav>
                <div id="content">
                    <p>Inside the content div.</p>
                </div>
            </div>
        `;
        const result = await extractHTML(html);
        expect(result.text).toContain("Inside the content div.");
        expect(result.text).not.toContain("Menu");
    });
});
