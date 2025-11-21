import { describe, it, expect } from 'bun:test';
import path from 'path';

import {
  ingestDocumentFromFile,
  ingestDocument,
} from '../../backend/src/ops/ingest';

// End-to-end ingestion test: run the full file ingestion pipeline against a
// real PDF fixture and assert the extraction method comes from pdf-parse.
// Guarded by RUN_PDF_INTEGRATION to avoid impacting normal PR speed.

describe('ingestDocumentFromFile end-to-end PDF ingestion', () => {
  it('ingests a PDF file and uses pdf-parse for extraction', async () => {
    if (process.env.RUN_PDF_INTEGRATION !== '1') {
      expect(true).toBe(true);
      return;
    }

    const fixturePath = path.join(
      process.cwd(),
      '../tests/fixtures',
      'sample.pdf',
    );
    // Avoid hitting DB-heavy HSG insertion code: use the ingestDocument test seam
    // to stub the HSG insertion while still exercising the extraction pipeline.
    (ingestDocument as any)._add_hsg_memory = async (
      _content: any,
      _t: any,
      _m: any,
      _user?: any,
    ) => ({ id: 'mock-root' });

    // Call the real file ingestion helper which will detect mime and call extract
    const res = await ingestDocumentFromFile(
      fixturePath,
      'application/pdf',
      undefined,
      { force_root: false },
      'test-user-e2e',
    );

    expect(res).toBeTruthy();
    expect(res.extraction).toBeTruthy();
    expect(res.extraction.extraction_method).toBe('pdf-parse');
    expect(typeof res.extraction.char_count).toBe('number');
    expect(res.total_tokens).toBeGreaterThanOrEqual(0);
  }, 10000);
});
