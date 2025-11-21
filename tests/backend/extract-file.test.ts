import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  extractPDFFromFile,
  extractDOCXFromFile,
} from '../../backend/src/ops/extract';

const fixturesDir = path.resolve('./tests/fixtures');
const samplePdf = path.join(fixturesDir, 'sample.pdf');
const tmpPdf = path.join(fixturesDir, 'tmp-sample.pdf');

describe('file-based extraction', () => {
  beforeAll(() => {
    // ensure fixtures dir exists
    if (!fs.existsSync(fixturesDir))
      fs.mkdirSync(fixturesDir, { recursive: true });
    // copy sample pdf if not exists (tests assume sample.pdf present)
    if (!fs.existsSync(samplePdf)) {
      // create a small PDF-like placeholder (not a valid PDF but extractors in CI use mocks)
      fs.writeFileSync(samplePdf, '%%PDF-placeholder%%');
    }
    fs.copyFileSync(samplePdf, tmpPdf);
  });

  afterAll(() => {
    try {
      fs.unlinkSync(tmpPdf);
    } catch (e) {}
  });

  it('extractPDFFromFile returns metadata and text', async () => {
    const res = await extractPDFFromFile(tmpPdf);
    expect(res).toBeDefined();
    expect(res.metadata).toBeDefined();
    expect(res.metadata.content_type).toBe('pdf');
    expect(typeof res.text).toBe('string');
  });

  it('extractDOCXFromFile returns metadata and text', async () => {
    const docx = path.join(fixturesDir, 'sample.docx');
    // create a minimal placeholder for docx if missing
    if (!fs.existsSync(docx)) fs.writeFileSync(docx, 'PK\u0003\u0004');
    const res = await extractDOCXFromFile(docx);
    expect(res).toBeDefined();
    expect(res.metadata.content_type).toBe('docx');
    expect(typeof res.text).toBe('string');
    try {
      fs.unlinkSync(docx);
    } catch (e) {}
  });
});
