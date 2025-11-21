const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

// Generate a PDF that simulates scanned/image-only pages by drawing large image-like rectangles
function generate(outputPath) {
    const doc = new PDFDocument({ autoFirstPage: false });
    const out = fs.createWriteStream(outputPath);
    doc.pipe(out);

    // Create 3 "scanned" pages
    for (let p = 1; p <= 3; p++) {
        doc.addPage({ size: "LETTER", margin: 0 });

        // Draw a large gray rectangle covering the page to simulate a scanned image background
        doc.rect(0, 0, doc.page.width, doc.page.height).fill("#f3f3f3");

        // Draw a darker rectangle centered to look like an embedded scanned image
        const margin = 40;
        doc.fill("#dcdcdc")
            .rect(
                margin,
                margin,
                doc.page.width - margin * 2,
                doc.page.height - margin * 2,
            )
            .fill();

        // Stamp some faint lines to simulate scanner artifacts
        doc.fill("#cfcfcf");
        for (let y = margin + 30; y < doc.page.height - margin - 30; y += 40) {
            doc.rect(
                margin + 10,
                y,
                doc.page.width - margin * 2 - 20,
                1,
            ).fill();
        }

        // Overlay a small "scanned" label
        doc.fill("#666")
            .fontSize(10)
            .text(`Scanned Page ${p}`, margin + 12, margin + 12);
    }

    doc.end();

    return new Promise((resolve, reject) => {
        out.on("finish", () => resolve());
        out.on("error", (err) => reject(err));
    });
}

if (require.main === module) {
    const outPath = path.join(
        __dirname,
        "..",
        "..",
        "tests",
        "fixtures",
        "sample_scanned.pdf",
    );
    generate(outPath)
        .then(() =>
            console.log("Generated scanned-like sample PDF at", outPath),
        )
        .catch((e) => {
            console.error("Failed to generate PDF:", e);
            process.exit(1);
        });
}

module.exports = { generate };
