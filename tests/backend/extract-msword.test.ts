++ new file mode 100644
import { describe, it, expect } from 'bun:test';
import { extractText } from '../../backend/src/ops/extract';

describe('extract msword handling', () => {
    it('treats ZIP-backed application/msword as docx', async () => {
        // PK\x03\x04 header - minimal zip signature
        const zipBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
        const res = await extractText('application/msword', zipBuf as any);
        // Should be treated as docx container (extraction may fallback to passthrough)
        expect(res.metadata.content_type).toBe('docx');
        expect(typeof res.text).toBe('string');
    });

    it('falls back to passthrough for legacy non-ZIP .doc', async () => {
        const plain = Buffer.from('This is a legacy .doc-like payload', 'utf8');
        const res = await extractText('application/msword', plain as any);
        expect(res.metadata.content_type).toBe('doc');
        expect(res.metadata.extraction_method).toBe('passthrough');
        expect(res.text).toContain('legacy .doc');
    });
});
