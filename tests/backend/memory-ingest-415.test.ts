import fs from "fs";
import path from "path";
import { test, expect } from "bun:test";

test("POST /memory/ingest maps UnsupportedContentTypeError to 415", async () => {
    const tmpDir = path.resolve(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, `openmemory-memory-ingest-415-${process.pid}-${Date.now()}.sqlite`);

    process.env.OM_NO_AUTO_START = "true";
    const port = 0;

    // Use the test seam to override ingestDocument so we can simulate the UnsupportedContentTypeError
    const ingestMod = await import("../../backend/src/ops/ingest.ts");
    const extractMod = await import("../../backend/src/ops/extract.ts");
    if (typeof (ingestMod as any).setIngestDocumentForTests === 'function') {
        (ingestMod as any).setIngestDocumentForTests(async () => {
            // Throw the typed error so the HTTP layer can map it to 415
            throw new (extractMod as any).UnsupportedContentTypeError('Unsupported content type: application/octet-stream');
        });
    } else {
        throw new Error('Test seam setIngestDocumentForTests not available');
    }

    const mod = await import("../../backend/src/server/index.ts");
    const start = mod.startServer as (opts?: { port?: number; dbPath?: string }) => Promise<{ stop: () => Promise<void> }>;
    const serverInfo = await start({ port, dbPath });
    const actualPort = (serverInfo as any).port || Number(process.env.OM_PORT) || port;

    const payload = {
        content_type: "application/octet-stream",
        data: Buffer.from("not-a-real-pdf-or-doc").toString("base64"),
    };

    const res = await fetch(`http://127.0.0.1:${actualPort}/memory/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    expect(res.status).toBe(415);
    const j = await res.json();
    expect(j).toHaveProperty("err");
    expect(j.err).toBe("unsupported_media_type");

    await serverInfo.stop();
});
