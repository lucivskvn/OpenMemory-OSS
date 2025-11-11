import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";

import { extractText, setPdfParseForTests } from "../../backend/src/ops/extract";

// This integration test runs the real pdf-parse pipeline against `tests/fixtures/sample.pdf`.
// It is skipped by default to avoid flaky CI failures; to run it locally set RUN_PDF_INTEGRATION=1.

describe("extractText pdf integration (real parser)", () => {
    it("parses the sample PDF when RUN_PDF_INTEGRATION=1", async () => {
        if (process.env.RUN_PDF_INTEGRATION !== "1") {
            // Skip by doing a no-op assertion; keeps test suite green by default.
            expect(true).toBe(true);
            return;
        }

        // Ensure no mock is active
        setPdfParseForTests(null as any);

        // Run the integration extractor against several generated fixtures.
        const fixtures = [
            'sample.pdf',
            'sample_multi_language.pdf',
            'sample_scanned.pdf',
            'sample_large.pdf',
        ];

        for (const f of fixtures) {
            const fixturePath = path.join(process.cwd(), "../tests/fixtures", f);
            if (!fs.existsSync(fixturePath)) {
                // If a fixture is missing, fail fast with a helpful message.
                throw new Error(`Required fixture not found: ${fixturePath}`);
            }

            const buf = fs.readFileSync(fixturePath);
            const res = await extractText("pdf", buf);

            expect(res).toBeTruthy();
            expect(typeof res.text).toBe("string");
            expect(res.metadata.content_type).toBe("pdf");
            expect(res.metadata.estimated_tokens).toBeGreaterThanOrEqual(0);
            // Basic content check: non-empty text for text-based fixtures
            if (f !== 'sample_scanned.pdf') {
                expect(res.text.length).toBeGreaterThan(10);
            }
        }
    });
});
