#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Create a PDF at filePath with the provided pages collection.
 * Each page entry is an object: { text, fontSize, options }
 * @param {string} filePath
 * @param {Array<object>} pages
 * @returns {Promise<void>}
 */
async function writePdf(filePath, pages) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);
        for (const p of pages) {
            if (p.options && p.options.addPage) doc.addPage();
            if (p.fontSize) doc.fontSize(p.fontSize);
            if (p.text) doc.text(p.text, { align: 'left' });
        }
        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}

/**
 * Regenerate the PDF fixtures used in tests/fixtures. This is a local dev helper.
 * @returns {Promise<void>}
 */
async function main() {
    const fixturesDirBackend = path.join(__dirname, '..', 'tests', 'fixtures');
    const fixturesDirRoot = path.join(__dirname, '..', '..', 'tests', 'fixtures');
    ensureDir(fixturesDirBackend);
    ensureDir(fixturesDirRoot);

    const samplePathBackend = path.join(fixturesDirBackend, 'sample.pdf');
    const sampleMultiPathBackend = path.join(fixturesDirBackend, 'sample_multi_language.pdf');
    const samplePathRoot = path.join(fixturesDirRoot, 'sample.pdf');
    const sampleMultiPathRoot = path.join(fixturesDirRoot, 'sample_multi_language.pdf');
    const sampleScannedPathBackend = path.join(fixturesDirBackend, 'sample_scanned.pdf');
    const sampleLargePathBackend = path.join(fixturesDirBackend, 'sample_large.pdf');
    const sampleScannedPathRoot = path.join(fixturesDirRoot, 'sample_scanned.pdf');
    const sampleLargePathRoot = path.join(fixturesDirRoot, 'sample_large.pdf');

    console.log('Generating', samplePathBackend);
    await writePdf(samplePathBackend, [
        { text: 'OpenMemory sample PDF - regression fixture', fontSize: 14 },
        { options: { addPage: true }, text: 'This is page 2. Hello, world!', fontSize: 12 },
    ]);

    console.log('Generating', sampleMultiPathBackend);
    await writePdf(sampleMultiPathBackend, [
        { text: 'OpenMemory sample PDF - multilingual', fontSize: 14 },
        { options: { addPage: true }, text: 'English: Hello\n日本語: こんにちは\n中文: 你好\nEspañol: Hola', fontSize: 12 },
    ]);

    // scanned - create a PDF that is primarily an image-like page (we'll just put large centered text)
    console.log('Generating', sampleScannedPathBackend);
    await writePdf(sampleScannedPathBackend, [
        { text: '\n\n\n\n\nSCANNED IMAGE PLACEHOLDER', fontSize: 36 },
    ]);

    // large - create a multi-page PDF to simulate a larger document
    console.log('Generating', sampleLargePathBackend);
    const largePages = [];
    for (let i = 0; i < 10; i++) {
        largePages.push({ text: `Large document page ${i + 1}\n` + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(50), fontSize: 10, options: { addPage: i !== 0 } });
    }
    await writePdf(sampleLargePathBackend, largePages);

    // Mirror into repo-root tests/fixtures so integration tests that reference
    // ../tests/fixtures (from backend) find the same PDFs.
    console.log('Copying to repo root fixtures:', samplePathRoot);
    fs.copyFileSync(samplePathBackend, samplePathRoot);
    console.log('Copying to repo root fixtures:', sampleMultiPathRoot);
    fs.copyFileSync(sampleMultiPathBackend, sampleMultiPathRoot);
    console.log('Copying to repo root fixtures:', sampleScannedPathRoot);
    fs.copyFileSync(sampleScannedPathBackend, sampleScannedPathRoot);
    console.log('Copying to repo root fixtures:', sampleLargePathRoot);
    fs.copyFileSync(sampleLargePathBackend, sampleLargePathRoot);

    console.log('Fixtures regenerated.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
