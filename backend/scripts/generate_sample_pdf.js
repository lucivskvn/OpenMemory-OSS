const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Generate a simple 3-page PDF with some text on each page
function generate(outputPath) {
  const doc = new PDFDocument({ autoFirstPage: false });
  const out = fs.createWriteStream(outputPath);
  doc.pipe(out);

  for (let i = 1; i <= 3; i++) {
    doc.addPage({ size: 'LETTER', margin: 50 });
    doc.fontSize(20).text(`Sample PDF Page ${i}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(
      `This is page ${i} of a generated multi-page PDF used as a test fixture for OpenMemory. ` +
        'It contains a few lines of text to ensure the PDF parser has content to extract.',
      { align: 'left', paragraphGap: 8 }
    );

    // Add some repeated paragraphs to make content longer
    for (let p = 0; p < 10; p++) {
      doc.text('Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus lacinia.');
    }
  }

  doc.end();

  return new Promise((resolve, reject) => {
    out.on('finish', () => resolve());
    out.on('error', (err) => reject(err));
  });
}

if (require.main === module) {
  const outPath = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'sample.pdf');
  generate(outPath)
    .then(() => console.log('Generated sample PDF at', outPath))
    .catch((e) => {
      console.error('Failed to generate PDF:', e);
      process.exit(1);
    });
}

module.exports = { generate };
