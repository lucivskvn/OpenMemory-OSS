import { describe, it, expect, beforeEach } from "bun:test";
import fs from "fs";
import path from "path";

import { extractText, setPdfParseForTests } from "../../backend/src/ops/extract";

// Consolidated PDF extractor tests (mock + optional integration).
// Controls:
// - RUN_PDF_FIXTURES=1   => run the mocked fixture-driven test (fast)
// - RUN_PDF_INTEGRATION=1 => run the real-parser integration test (skipped by default)

function mockPdfParse(buffer: Buffer) {
    return Promise.resolve({
        text: "Mocked PDF text content",
        numpages: 1,
        pages: 1,
        info: { mocked: true },
    });
}

describe("extractText pdf pathway (mock + integration)", () => {
    beforeEach(() => {
        // reset any test seam before each test; individual tests will override as needed
        setPdfParseForTests(null as any);
    });

    it("mocked pdf-parse returns expected text and metadata when RUN_PDF_FIXTURES=1", async () => {
        const runPdfFixtures = process.env.RUN_PDF_FIXTURES === '1';
        if (!runPdfFixtures) return; // no-op when fixtures not requested

        setPdfParseForTests(mockPdfParse);

        const candidates = [
            path.resolve(process.cwd(), "tests", "fixtures", "sample.pdf"),
            path.resolve(__dirname, "..", "fixtures", "sample.pdf"),
            path.resolve(__dirname, "..", "..", "tests", "fixtures", "sample.pdf"),
        ];
        let fixturePath: string | null = null;
        for (const c of candidates) if (fs.existsSync(c)) { fixturePath = c; break; }
        if (!fixturePath) throw new Error(`Required fixture not found in candidates: ${candidates.join(', ')}`);

        const fixture = fs.readFileSync(fixturePath);
        const res = await extractText("pdf", fixture);

        expect(res).toBeTruthy();
        expect(res.text).toBe("Mocked PDF text content");
        expect(res.metadata.content_type).toBe("pdf");
        expect(res.metadata.pages).toBe(1);
        expect(res.metadata.info).toEqual({ mocked: true });
    });

    it("integration: real pdf-parse parses sample fixtures when RUN_PDF_INTEGRATION=1", async () => {
        if (process.env.RUN_PDF_INTEGRATION !== "1") {
            expect(true).toBe(true);
            return;
        }

        // Ensure no mock is active
        setPdfParseForTests(null as any);

        const fixtures = [
            'sample.pdf',
            'sample_multi_language.pdf',
            'sample_scanned.pdf',
            'sample_large.pdf',
        ];

        for (const f of fixtures) {
            const fixturePath = path.join(process.cwd(), "tests/fixtures", f);
            if (!fs.existsSync(fixturePath)) throw new Error(`Required fixture not found: ${fixturePath}`);

            const buf = fs.readFileSync(fixturePath);
            const res = await extractText("pdf", buf);

            expect(res).toBeTruthy();
            expect(typeof res.text).toBe("string");
            expect(res.metadata.content_type).toBe("pdf");
            expect(res.metadata.estimated_tokens).toBeGreaterThanOrEqual(0);
            if (f !== 'sample_scanned.pdf') {
                expect(res.text.length).toBeGreaterThan(10);
            }
        }
    });
});

// Merged tests from `tests/backend/extract-pdf-mock.test.ts` (consolidation)
// Appended the mock-only test-block to preserve coverage from the duplicate file.
describe("extractText pdf pathway with mocked pdf-parse (merged)", () => {
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
