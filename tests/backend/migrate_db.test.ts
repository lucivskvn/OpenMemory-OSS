import fs from "fs";
import path from "path";
import { test, expect } from "bun:test";

import { Database } from "bun:sqlite";

test("startServer({dbPath}) applies migrations to the provided sqlite DB", async () => {
    const tmpDir = path.resolve(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, `openmemory-migrate-${process.pid}-${Date.now()}.sqlite`);

    // Prevent auto-start so we can control startServer
    process.env.OM_NO_AUTO_START = "true";

    const port = 18000 + (process.pid % 1000) + 1;

    const mod = await import("../../backend/src/server/index.ts");
    const start = mod.startServer as (opts?: { port?: number; dbPath?: string; waitUntilReady?: boolean }) => Promise<{ stop: () => Promise<void> }>;

    const server = await start({ port, dbPath, waitUntilReady: true });

    // wait briefly for migrations to settle
    await new Promise((r) => setTimeout(r, 300));

    // verify the sqlite file exists and contains the `memories` table
    expect(fs.existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath);
    const row: any = db.query("select name from sqlite_master where type='table' and name='memories'").get();
    db.close();

    expect(row).not.toBeUndefined();
    // bun:sqlite may return a row as an object ({ name: 'memories' }) or an array
    // depending on runtime; accept both shapes for robustness in tests.
    const found = row && (row.name ?? row[0]);
    expect(found).toBe("memories");

    await server.stop();
});
