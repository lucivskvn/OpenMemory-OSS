import fs from "fs";
import path from "path";
import { test, expect } from "bun:test";

test("POST /memory/ingest maps ERR_FILE_TOO_LARGE to 413", async () => {
    const tmpDir = path.resolve(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, `openmemory-memory-ingest-413-${process.pid}-${Date.now()}.sqlite`);

    process.env.OM_NO_AUTO_START = "true";
    const port = 18200 + (process.pid % 1000);

    // Use the test seam to override ingestDocument so we can simulate the file-too-large error
    const ingestMod = await import("../../backend/src/ops/ingest.ts");
    if (typeof (ingestMod as any).setIngestDocumentForTests === 'function') {
        (ingestMod as any).setIngestDocumentForTests(async () => {
            const err: any = new Error("File too large");
            err.code = "ERR_FILE_TOO_LARGE";
            err.name = "FileTooLargeError";
            throw err;
        });
    } else {
        throw new Error('Test seam setIngestDocumentForTests not available');
    }

    const mod = await import("../../backend/src/server/index.ts");
    const start = mod.startServer as (opts?: { port?: number; dbPath?: string }) => Promise<{ stop: () => Promise<void> }>;
    const server = await start({ port, dbPath });

    const payload = {
        content_type: "text",
        data: Buffer.from("small").toString("base64"),
    };

    const res = await fetch(`http://127.0.0.1:${port}/memory/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    expect(res.status).toBe(413);
    const j = await res.json();
    expect(j).toHaveProperty("err");
    expect(j.err).toBe("file_too_large");

    await server.stop();
});
