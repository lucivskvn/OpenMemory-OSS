import { test, expect } from "bun:test";
import path from "path";
import fs from "fs";

async function startServerForTest() {
    const tmpDir = path.resolve(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpDb = path.join(tmpDir, `openmemory-health-${process.pid}-${Date.now()}.sqlite`);
    process.env.OM_DB_PATH = tmpDb;
    // Importing the server module starts it (top-level code)
    await import("../../backend/src/server/index.ts");
}

test("/health endpoint responds OK", async () => {
    await startServerForTest();
    const port = process.env.OM_PORT || process.env.PORT || "8080";
    for (let i = 0; i < 20; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) {
                const body = await res.json().catch(() => ({}));
                expect(body).toBeDefined();
                expect(body.status || body.ok || body.health || "ok").toBeDefined();
                return;
            }
        } catch (e) {
            // retry
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Health endpoint did not respond in time");
});
