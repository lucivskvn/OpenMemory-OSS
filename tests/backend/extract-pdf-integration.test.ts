import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { extractPDF, setPdfParseForTests } from '../../backend/src/ops/extract';

// This integration test exercises the real `pdf-parse` pipeline against the
// committed fixtures. It runs only when RUN_PDF_INTEGRATION=1 is set so it can
// be enabled in CI without affecting fast local runs.

describe('extractPDF integration (real pdf-parse)', () => {
  it('parses sample PDF fixtures using pdf-parse and reports extraction_method', async () => {
    if (process.env.RUN_PDF_INTEGRATION !== '1') {
      expect(true).toBe(true);
      return;
    }

    // Ensure test seam is disabled to force the real module import
    setPdfParseForTests(null as any);

    const fixtures = [
      'sample.pdf',
      'sample_multi_language.pdf',
      'sample_scanned.pdf',
      'sample_large.pdf',
    ];

    for (const f of fixtures) {
      const fixturePath = path.join(process.cwd(), '../tests/fixtures', f);
      if (!fs.existsSync(fixturePath)) {
        throw new Error(`Required fixture not found: ${fixturePath}`);
      }

      // Use Bun.file arrayBuffer path where possible to mirror CI behavior
      const arr = await Bun.file(fixturePath).arrayBuffer();
      const buffer = Buffer.from(arr);

      const res = await extractPDF(buffer);

      expect(res).toBeTruthy();
      expect(typeof res.text).toBe('string');
      expect(res.metadata.content_type).toBe('pdf');
      // Ensure we exercised the real pdf-parse implementation
      expect(res.metadata.extraction_method).toBe('pdf-parse');
      expect(res.metadata.estimated_tokens).toBeGreaterThanOrEqual(0);
      // Basic non-empty expectation for text-based fixtures
      if (f !== 'sample_scanned.pdf')
        expect(res.text.length).toBeGreaterThan(0);
    }
  }, 10000);
});
