import fs from "fs";
import path from "path";
import { test, expect } from "bun:test";

test("POST /agent accepts valid payload and returns JSON", async () => {
    const tmpDir = path.resolve(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, `openmemory-agent-${process.pid}-${Date.now()}.sqlite`);

    process.env.OM_NO_AUTO_START = "true";
    const port = 18100 + (process.pid % 1000);
    const mod = await import("../../backend/src/server/index.ts");
    const start = mod.startServer as (opts?: { port?: number; dbPath?: string }) => Promise<{ stop: () => Promise<void> }>;
    const server = await start({ port, dbPath });

    // POST /agent
    const payload = { id: "test-agent-1", goal: "noop test" };
    const res = await fetch(`http://127.0.0.1:${port}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toHaveProperty("status");
    expect(j.status).toBe("accepted");

    await server.stop();
});
