import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { ingestDocumentFromFile } from '../../backend/src/ops/ingest';

const fixturesDir = path.resolve('./tests/fixtures');
const smallTxt = path.join(fixturesDir, 'tmp-small.txt');
const largeTxt = path.join(fixturesDir, 'tmp-large.txt');

describe('file-based ingestion', () => {
    beforeAll(() => {
        if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
        fs.writeFileSync(smallTxt, 'Hello world. This is a small test file.');
    });

    afterAll(() => {
        try { fs.unlinkSync(smallTxt); } catch (e) { }
        try { fs.unlinkSync(largeTxt); } catch (e) { }
    });

    it('throws when file is missing', async () => {
        await expect(ingestDocumentFromFile(path.join(fixturesDir, 'does-not-exist.txt'), 'text')).rejects.toThrow();
    });

    it('throws when file exceeds size guard (200 MB)', async () => {
        // create a large file (>200MB) by truncating
        const size = 201 * 1024 * 1024;
        const fd = fs.openSync(largeTxt, 'w');
        try {
            fs.ftruncateSync(fd, size);
        } finally {
            fs.closeSync(fd);
        }
        await expect(ingestDocumentFromFile(largeTxt, 'text')).rejects.toThrow('File too large');
    });

    // Note: full end-to-end ingestion requires DB setup; those tests belong in an integration
    // environment where the backend test harness starts with SQLite/Postgres. The above
    // tests validate file-path handling and size guards around Bun.file().
});
