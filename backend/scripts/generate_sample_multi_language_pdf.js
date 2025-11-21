const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

// Generate a PDF containing multi-language text (Chinese, Arabic, Hindi, Cyrillic, Emoji)
function generate(outputPath) {
    const doc = new PDFDocument({ autoFirstPage: false });
    const out = fs.createWriteStream(outputPath);
    doc.pipe(out);

    doc.addPage({ size: "LETTER", margin: 50 });
    doc.fontSize(18).text("OpenMemory — Multi-language Sample", {
        align: "center",
    });
    doc.moveDown(1);

    const paragraphs = [
        "English: The quick brown fox jumps over the lazy dog.",
        "中文：快速的棕色狐狸跳过了懒狗。",
        "العربية: الثعلب البني السريع يقفز فوق الكلب الكسول.",
        "Русский: Быстрая коричневая лиса перепрыгивает через ленивую собаку.",
        "हिंदी: तेज भूरी लोमड़ी सुस्त कुत्ते के ऊपर कूदती है।",
        "Emoji: 😀🚀📄 — testing emoji handling and UTF-8 content.",
    ];

    doc.fontSize(12);
    paragraphs.forEach((p) => {
        doc.text(p, { paragraphGap: 6 });
        doc.moveDown(0.5);
    });

    // Add a second page with repeated multi-language text
    doc.addPage({ size: "LETTER", margin: 50 });
    doc.fontSize(12);
    for (let i = 0; i < 30; i++) {
        doc.text(paragraphs[i % paragraphs.length]);
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
        "sample_multi_language.pdf",
    );
    generate(outPath)
        .then(() =>
            console.log("Generated multi-language sample PDF at", outPath),
        )
        .catch((e) => {
            console.error("Failed to generate PDF:", e);
            process.exit(1);
        });
}

module.exports = { generate };
