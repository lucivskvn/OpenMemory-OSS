const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Generate a large multi-page PDF (~50 pages) to exercise performance and pagination
function generate(outputPath, pages = 50) {
    const doc = new PDFDocument({ autoFirstPage: false });
    const out = fs.createWriteStream(outputPath);
    doc.pipe(out);

    for (let i = 1; i <= pages; i++) {
        doc.addPage({ size: 'LETTER', margin: 50 });
        doc.fontSize(16).text(`Large Sample PDF — Page ${i}`, { align: 'center' });
        doc.moveDown();

        // Add several paragraphs per page
        doc.fontSize(10);
        for (let p = 0; p < 20; p++) {
            doc.text(
                `This is paragraph ${p + 1} on page ${i}. It exists to create a reasonably sized document and test token estimation, page splitting, and parser resilience.`
            );
            doc.moveDown(0.2);
        }
    }

    doc.end();

    return new Promise((resolve, reject) => {
        out.on('finish', () => resolve());
        out.on('error', (err) => reject(err));
    });
}

if (require.main === module) {
    const outPath = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'sample_large.pdf');
    generate(outPath, 50)
        .then(() => console.log('Generated large sample PDF at', outPath))
        .catch((e) => {
            console.error('Failed to generate PDF:', e);
            process.exit(1);
        });
}

module.exports = { generate };
