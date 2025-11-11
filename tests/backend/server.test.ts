import { describe, it, expect } from "bun:test";
import path from "path";
import fs from "fs";

async function startServerForTest() {
    const tmpDir = path.resolve(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpDb = path.join(tmpDir, `openmemory-server-${process.pid}-${Date.now()}.sqlite`);
    process.env.OM_DB_PATH = tmpDb;
    await import("../../backend/src/server/index.ts");
}

describe("server health", () => {
    it("/health returns 200", async () => {
        await startServerForTest();
        const resp = await fetch("http://localhost:8080/health");
        expect(resp.ok).toBe(true);
        const json = await resp.json();
        // Health payload may vary; at minimum expect an OK flag or version
        expect(json.ok || json.version).toBeDefined();
    });
});
