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
        // Allow tests to be skipped locally when RUN_PDF_FIXTURES!=1. In CI we
        // export RUN_PDF_FIXTURES=1 so the fixture check runs. Also try several
        // candidate paths so running tests from `backend/` or repo root both work.
        const runPdfFixtures = process.env.RUN_PDF_FIXTURES === '1';
        if (!runPdfFixtures) {
            // No-op test variant when fixtures are not requested.
            return;
        }

        const candidates = [
            path.resolve(process.cwd(), "tests", "fixtures", "sample.pdf"),
            path.resolve(__dirname, "..", "fixtures", "sample.pdf"),
            path.resolve(__dirname, "..", "..", "tests", "fixtures", "sample.pdf"),
        ];
        let fixturePath: string | null = null;
        for (const c of candidates) if (fs.existsSync(c)) { fixturePath = c; break; }
        if (!fixturePath) {
            throw new Error(`Required fixture not found in candidates: ${candidates.join(', ')}`);
        }
        const fixture = fs.readFileSync(fixturePath);
        const res = await extractText("pdf", fixture);
        expect(res).toBeTruthy();
        expect(res.text).toBe("Mocked PDF text content");
        expect(res.metadata.content_type).toBe("pdf");
        expect(res.metadata.pages).toBe(1);
        expect(res.metadata.info).toEqual({ mocked: true });
    });
});
