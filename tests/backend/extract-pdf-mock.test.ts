import { describe, it, expect, beforeEach } from "bun:test";
import fs from "fs";
import path from "path";

// Import the module under test
import { extractText, setPdfParseForTests } from "../../backend/src/ops/extract";

// A deterministic mock for pdf-parse: accepts a buffer and returns a resolved object
function mockPdfParse(buffer: Buffer) {
    return Promise.resolve({
        text: "Mocked PDF text content",
        numpages: 1,
        pages: 1,
        info: { mocked: true },
    });
}

describe("extractText pdf pathway with mocked pdf-parse", () => {
    beforeEach(() => {
        // Inject the mock implementation so extractPDF uses it instead of the real parser
        setPdfParseForTests(mockPdfParse);
    });

    it("returns the mocked text and metadata", async () => {
        const fixture = fs.readFileSync(path.join(process.cwd(), "../tests/fixtures/sample.pdf"));
        const res = await extractText("pdf", fixture);
        expect(res).toBeTruthy();
        expect(res.text).toBe("Mocked PDF text content");
        expect(res.metadata.content_type).toBe("pdf");
        expect(res.metadata.pages).toBe(1);
        expect(res.metadata.info).toEqual({ mocked: true });
    });
});
