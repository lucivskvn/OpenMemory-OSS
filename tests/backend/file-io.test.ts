import { describe, it, expect } from 'bun:test';
import { readFile, writeFile, fileExists } from '../../backend/src/utils';
import { unlinkSync } from 'fs';
import path from 'path';
import fs from 'fs';
import * as ExtractOps from '../../backend/src/ops/extract';

// Global test mocks to avoid parsing real binaries in unit tests
(ExtractOps as any).setPdfParseForTests(async (buf: Buffer) => ({ text: 'mock pdf text', numpages: 1 }));
; (ExtractOps as any).setMammothForTests(async (opts: any) => ({ value: 'mock docx text', messages: [] }));
; (ExtractOps as any).setMammothForTests({ extractRawText: async ({ buffer }: { buffer: Buffer }) => ({ value: 'mock docx text', messages: [] }) });
import { ingestDocumentFromFile } from '../../backend/src/ops/ingest';

const TMP = 'tests/tmp-test-file.txt';

describe('file I/O helpers', () => {
    it('write and read file', async () => {
        await writeFile(TMP, 'hello');
        expect(await fileExists(TMP)).toBe(true);
        const buf = await readFile(TMP);
        const txt = new TextDecoder().decode(buf);
        expect(txt).toBe('hello');
        try { unlinkSync(TMP); } catch (e) { }
    });

    it('file-based extract parity with buffer-based extract', async () => {
        const fixturesDir = path.resolve('./tests/fixtures');
        if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
        const samplePdf = path.join(fixturesDir, 'sample.pdf');
        const sampleDocx = path.join(fixturesDir, 'sample.docx');
        // create minimal placeholders if missing
        if (!fs.existsSync(samplePdf)) fs.writeFileSync(samplePdf, '%%PDF-placeholder%%');
        if (!fs.existsSync(sampleDocx)) fs.writeFileSync(sampleDocx, 'PK\u0003\u0004');

        // PDF: file-based vs buffer-based
        // Inject a mock pdf-parse implementation so tests don't depend on a real PDF binary
        (ExtractOps as any).setPdfParseForTests(async (buf: Buffer) => ({ text: 'mock pdf text', numpages: 1 }));
        const resFilePdf = await ExtractOps.extractPDFFromFile(samplePdf);
        const bufPdf = await fs.promises.readFile(samplePdf);
        const resBufPdf = await ExtractOps.extractPDF(Buffer.from(bufPdf));
        expect(resFilePdf).toBeDefined();
        expect(resBufPdf).toBeDefined();
        expect(resFilePdf.metadata.content_type).toBe(resBufPdf.metadata.content_type);
        expect(typeof resFilePdf.text).toBe('string');
        // metadata enrichment: duration and file size
        expect(typeof resFilePdf.metadata.extraction_duration_ms).toBe('number');
        expect(resFilePdf.metadata).toHaveProperty('file_size_bytes');
        expect(typeof resFilePdf.metadata.file_size_bytes === 'number' || resFilePdf.metadata.file_size_bytes === null).toBe(true);

        // DOCX: file-based vs buffer-based
        const resFileDocx = await ExtractOps.extractDOCXFromFile(sampleDocx);
        const bufDocx = await fs.promises.readFile(sampleDocx);
        const resBufDocx = await ExtractOps.extractDOCX(Buffer.from(bufDocx));
        expect(resFileDocx).toBeDefined();
        expect(resBufDocx).toBeDefined();
        expect(resFileDocx.metadata.content_type).toBe(resBufDocx.metadata.content_type);
        expect(typeof resFileDocx.text).toBe('string');
        // metadata enrichment: duration and file size
        expect(typeof resFileDocx.metadata.extraction_duration_ms).toBe('number');
        expect(resFileDocx.metadata).toHaveProperty('file_size_bytes');
        expect(typeof resFileDocx.metadata.file_size_bytes === 'number' || resFileDocx.metadata.file_size_bytes === null).toBe(true);
    });

    it('octet-stream strict mode rejects unknown binaries and legacy env accepts as text', async () => {
        const payload = Buffer.from('this-is-not-pdf-or-zip');
        // Default: strict mode should throw
        let threw = false;
        try {
            await ExtractOps.extractText('application/octet-stream', payload);
        } catch (e: any) {
            threw = true;
        }
        expect(threw).toBe(true);

        // With legacy opt-in, the same payload should be accepted as text
        const prev = process.env.OM_ACCEPT_OCTET_LEGACY;
        try {
            process.env.OM_ACCEPT_OCTET_LEGACY = 'true';
            const res = await ExtractOps.extractText('application/octet-stream', payload);
            expect(res).toBeDefined();
            expect(res.metadata.content_type).toBe('text');
            expect(typeof res.text).toBe('string');
        } finally {
            if (prev === undefined) delete process.env.OM_ACCEPT_OCTET_LEGACY;
            else process.env.OM_ACCEPT_OCTET_LEGACY = prev;
        }
    });

    it('extractText accepts common MIME types', async () => {
        const text = 'Hello world';
        const r1 = await ExtractOps.extractText('application/pdf', Buffer.from('%%PDF-placeholder%%'));
        expect(r1.metadata.content_type).toBe('pdf');
        const r2 = await ExtractOps.extractText('text/html; charset=utf-8', '<p>hi</p>');
        expect(r2.metadata.content_type).toBe('html');
        // markdown and plain text strings should be treated as raw UTF-8 (not base64)
        const mdIn = '# Title\n\nHello **world**';
        const rmd = await ExtractOps.extractText('text/markdown', mdIn);
        expect(rmd.metadata.content_type).toBe('markdown');
        expect(rmd.text).toBe(mdIn);
        const txtIn = 'Just some plain text';
        const rtxt = await ExtractOps.extractText('text/plain', txtIn);
        expect(rtxt.metadata.content_type).toBe('text');
        expect(rtxt.text).toBe(txtIn);
        const r3 = await ExtractOps.extractText('application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('PK\u0003\u0004'));
        expect(r3.metadata.content_type).toBe('docx');
    });

    it('ingestDocumentFromFile basic file handling', async () => {
        const fixturesDir = path.resolve('./tests/fixtures');
        const smallTxt = path.join(fixturesDir, 'tmp-test-ingest.txt');
        await fs.promises.writeFile(smallTxt, 'Hello from ingest test');
        // Mock DB interactions so this test only validates file I/O and ingestion wiring
        // stub q and transaction to avoid real DB calls by injecting into ingest seam
        const Ingest = await import('../../backend/src/ops/ingest');
        const fakeQ = { ins_mem: { run: async (..._a: any[]) => ({}) }, ins_waypoint: { run: async (..._a: any[]) => ({}) } };
        const fakeTxn = { begin: async () => { }, commit: async () => { }, rollback: async () => { } };
        (Ingest.ingestDocument as any)._q = fakeQ;
        (Ingest.ingestDocument as any)._transaction = fakeTxn;

        // Also mock extractText to a known result to avoid parser dependencies
        if ((ExtractOps as any).setExtractTextForTests) {
            (ExtractOps as any).setExtractTextForTests(async (_t: any, _data: any) => ({ text: 'Hello from ingest test', metadata: { content_type: 'text', estimated_tokens: 1 } }));
        }

        // Override add_hsg_memory used by ingestDocument via the seam we added
        (Ingest.ingestDocument as any)._add_hsg_memory = async (_txt: any, _tags: any, _meta: any, _user?: any) => ({ id: 'mock-id' });

        const res = await Ingest.ingestDocumentFromFile(smallTxt, 'text');
        expect(res).toBeDefined();
        expect(res.root_memory_id).toBe('mock-id');
        expect(res.child_count).toBe(0);
        try { await fs.promises.unlink(smallTxt); } catch (e) { }
    });

    it('ingestDocumentFromFile enforces max size and throws FileTooLargeError', async () => {
        const fixturesDir = path.resolve('./tests/fixtures');
        const bigTxt = path.join(fixturesDir, 'tmp-test-ingest-large.txt');
        const content = 'A'.repeat(200);
        await fs.promises.writeFile(bigTxt, content);
        const Ingest = await import('../../backend/src/ops/ingest');
        // reuse the same DB/transaction stubs as other test
        const fakeQ = { ins_mem: { run: async (..._a: any[]) => ({}) }, ins_waypoint: { run: async (..._a: any[]) => ({}) } };
        const fakeTxn = { begin: async () => { }, commit: async () => { }, rollback: async () => { } };
        (Ingest.ingestDocument as any)._q = fakeQ;
        (Ingest.ingestDocument as any)._transaction = fakeTxn;
        if ((ExtractOps as any).setExtractTextForTests) {
            (ExtractOps as any).setExtractTextForTests(async (_t: any, _data: any) => ({ text: 'big file', metadata: { content_type: 'text', estimated_tokens: 1 } }));
        }
        (Ingest.ingestDocument as any)._add_hsg_memory = async (_txt: any, _tags: any, _meta: any, _user?: any) => ({ id: 'mock-id' });

        let threw = false;
        try {
            await Ingest.ingestDocumentFromFile(bigTxt, 'text', undefined, { max_size_mb: 0.0001 });
        } catch (e: any) {
            threw = true;
            expect(e && e.name).toBe('FileTooLargeError');
        } finally {
            try { await fs.promises.unlink(bigTxt); } catch (e) { }
        }
        expect(threw).toBe(true);
    });
});
