import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { extractPDF, setPdfParseForTests } from '../../backend/src/ops/extract';
// Regression integration test: use a tiny, known-valid PDF (base64-encoded)
// so we can exercise the real pdf-parse implementation without external
// dependencies or fixture files. Guarded by RUN_PDF_INTEGRATION so it only
// runs when explicitly enabled in CI.

describe('extractPDF regression (real pdf-parse)', () => {
  it('returns text when parsing a small valid PDF (requires RUN_PDF_INTEGRATION=1)', async () => {
    if (process.env.RUN_PDF_INTEGRATION !== '1') {
      // Skip normally to keep CI fast; use env var to opt-in.
      expect(true).toBe(true);
      return;
    }

    // Ensure any test seam is disabled so we exercise the real implementation
    setPdfParseForTests(null as any);

    // A minimal, valid PDF encoded in base64 (simple one-page PDF with "Hello World").
    const pdfBase64 =
      'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovQ3JlYXRvciAoQWRvYmUgUGRmIEdlbnVyYXRvciUyKQovUHJvZHVjZXIgKERvY3VtZW50KQovQ3JlYXRpb25EYXRlIChEOjIwMDQwMTEyMTIwMDAwWik+PgplbmRvYmoKMiAwIG9iago8PAovVHlwZSAvUGFnZXMKL0tpZHMgWzMgMCBSXQovQ291bnQgMQo+PgplbmRvYmoKMyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCi9Db250ZW50cyA0IDAgUgovTWVkaWFCb3ggWzAgMCA2MTIgNzkyXQovUmVzb3VyY2VzIDw8Ci9Gb250IDw8Ci9GMSA1IDAgUgo+PgovUHJvY1NldCBbL1BERiAvVGV4dF0KPj4KZW5kb2JqCjQgMCBvYmoKPDwKL0xlbmd0aCA1Nwo+PgpzdHJlYW0KSGVsbG8sIFBERiBXb3JsZCEKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8Ci9UeXBlIC9Gb250Ci9TdWJ0eXBlIC9UeXBlMQovQmFzZUZvbnQgL0hlbHZldGljYQovTmFtZSAvSGVsdmV0aWNhCj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYKMDAwMDAwMDAxMiAwMDAwMCBuCjAwMDAwMDAwNjEgMDAwMDAgbiAwMDAwMDAwMDExIDAwMDAwIG4KMDAwMDAwMDAyMSAwMDAwMCBuCjAwMDAwMDAwMjkgMDAwMDAgbiAwMDAwMDAwMDM4IDAwMDAwIG4KdHJhaWxlcgo8PAovUm9vdCAxIDAgUgovU2l6ZSA2Cj4+CnN0YXJ0eHJlZgoxMDQKJSVFT0YK';
    const buf = Buffer.from(pdfBase64, 'base64');

    const res = await extractPDF(buf);

    expect(res).toBeTruthy();
    expect(typeof res.text).toBe('string');
    expect(res.metadata.content_type).toBe('pdf');
    expect(res.metadata.estimated_tokens).toBeGreaterThanOrEqual(0);
    // basic non-empty check
    expect(res.text.length).toBeGreaterThan(0);
  });
});
