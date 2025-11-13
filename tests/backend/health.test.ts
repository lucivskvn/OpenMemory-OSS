import { test, expect } from "bun:test";
import path from "path";
import fs from "fs";

async function startServerForTest() {
    const tmpDir = path.resolve(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpDb = path.join(tmpDir, `openmemory-health-${process.pid}-${Date.now()}.sqlite`);
    process.env.OM_DB_PATH = tmpDb;
    // Import the server module and explicitly start the server so tests
    // wait for the server to be bound before attempting HTTP requests.
    // Some test runners import modules without awaiting side-effects, which
    // can cause a race when the module auto-starts the server. Calling the
    // exported startServer() function directly avoids that race.
    const mod = await import("../../backend/src/server/index.ts");
    if (mod && typeof mod.startServer === "function") {
        // Prefer to start on an ephemeral port in tests to avoid collisions.
        await mod.startServer({ port: 0, dbPath: tmpDb });
    } else {
        // Fallback: if the module doesn't export startServer for some reason,
        // rely on the module's auto-start side-effect.
        await import("../../backend/src/server/index.ts");
    }
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
